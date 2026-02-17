import * as vscode from "vscode";
import { logger } from "./logger";

/**
 * Maximum length of the assistant response text to send for characterization.
 * Longer texts are truncated to save tokens.
 */
const MAX_TEXT_LENGTH = 500;

/**
 * Timeout for a single characterization request (ms).
 */
const CHARACTERIZATION_TIMEOUT_MS = 5_000;

/**
 * Retry backoff delays (ms). Each entry is one retry attempt.
 * Total worst-case: 5s request + 1s wait + 5s request + 3s wait + 5s request = 19s.
 */
const RETRY_DELAYS_MS = [1_000, 3_000, 8_000];

/**
 * System prompt for turn characterization.
 * Kept minimal to reduce token usage.
 */
const CHARACTERIZATION_SYSTEM_PROMPT = `Summarize what happened in this assistant turn in 3-6 words. Output ONLY the summary, no quotes or punctuation. Examples: "Refactored auth middleware", "Fixed login form bug", "Added unit tests".`;

/**
 * Result of a characterization attempt.
 * Always returns one of: a characterization string, or an error explaining why it failed.
 */
export interface CharacterizationResult {
  /** The generated characterization label, if successful. */
  characterization?: string;
  /** Error message if characterization failed after all retries. */
  error?: string;
}

/**
 * Generates a concise characterization for a conversation turn using a Copilot model.
 *
 * Uses VS Code's Language Model API to find a free Copilot model
 * and generate a short label from the assistant's response text.
 *
 * Features:
 * - Properly wired timeout via CancellationTokenSource
 * - Retry with exponential backoff (3 attempts)
 * - Structured result type (always returns characterization or error)
 *
 * @example
 * ```ts
 * const characterizer = getTurnCharacterizer();
 * const result = await characterizer.characterize("I've refactored the auth middleware to use...");
 * if (result.characterization) {
 *   // "Refactored auth middleware"
 * } else {
 *   // result.error explains why
 * }
 * ```
 */
export class TurnCharacterizer {
  private cachedModel: vscode.LanguageModelChat | null = null;
  private modelSelectionPromise: Promise<vscode.LanguageModelChat | null> | null =
    null;

  /**
   * Generate a characterization for a turn based on the assistant response text.
   * Retries up to 3 times with backoff on failure.
   *
   * @param responseText The assistant's response text for the turn
   * @returns A structured result with either characterization or error
   */
  async characterize(responseText: string): Promise<CharacterizationResult> {
    // Skip empty or very short responses
    if (!responseText || responseText.trim().length < 10) {
      return { error: "Response too short to characterize" };
    }

    const model = await this.getModel();
    if (!model) {
      return { error: "No Copilot model available" };
    }

    // Truncate long texts to save tokens
    const truncated =
      responseText.length > MAX_TEXT_LENGTH
        ? responseText.slice(0, MAX_TEXT_LENGTH) + "..."
        : responseText;

    const messages: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(
        `${CHARACTERIZATION_SYSTEM_PROMPT}\n\nAssistant response:\n${truncated}`,
      ),
    ];

    // Attempt with retries
    let lastError: string | undefined;
    const maxAttempts = RETRY_DELAYS_MS.length + 1; // 1 initial + retries

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Wait before retry (not before first attempt)
      if (attempt > 0) {
        const delay = RETRY_DELAYS_MS[attempt - 1]!;
        logger.debug(
          `[TurnCharacterizer] Retry ${attempt.toString()}/${RETRY_DELAYS_MS.length.toString()} after ${delay.toString()}ms`,
        );
        await sleep(delay);
      }

      try {
        const result = await this.sendRequestWithTimeout(model, messages);
        if (result) {
          const cleaned = this.cleanCharacterization(result);
          if (cleaned.length > 0) {
            logger.debug(
              `[TurnCharacterizer] Generated characterization: "${cleaned}" (attempt ${(attempt + 1).toString()})`,
            );
            return { characterization: cleaned };
          }
          lastError = "Empty characterization after cleaning";
        } else {
          lastError = "No response from model";
        }
      } catch (error) {
        lastError =
          error instanceof Error ? error.message : String(error);
        logger.debug(
          `[TurnCharacterizer] Attempt ${(attempt + 1).toString()} failed: ${lastError}`,
        );
      }
    }

    logger.debug(
      `[TurnCharacterizer] All ${maxAttempts.toString()} attempts failed: ${lastError ?? "unknown"}`,
    );
    return { error: lastError ?? "All attempts failed" };
  }

  /**
   * Get a Copilot model for characterization.
   * Caches the model selection to avoid repeated lookups.
   */
  private async getModel(): Promise<vscode.LanguageModelChat | null> {
    if (this.cachedModel) {
      return this.cachedModel;
    }

    if (this.modelSelectionPromise) {
      return this.modelSelectionPromise;
    }

    this.modelSelectionPromise = this.selectModel();
    try {
      this.cachedModel = await this.modelSelectionPromise;
      return this.cachedModel;
    } finally {
      this.modelSelectionPromise = null;
    }
  }

  /**
   * Select a suitable Copilot model for characterization.
   * Prefers smaller/faster models like gpt-4o-mini.
   */
  private async selectModel(): Promise<vscode.LanguageModelChat | null> {
    try {
      const models = await vscode.lm.selectChatModels({ vendor: "copilot" });

      if (models.length === 0) {
        logger.debug("[TurnCharacterizer] No Copilot models available");
        return null;
      }

      // Prefer smaller/faster models
      const preferredModel = models.find(
        (m) =>
          m.family.includes("gpt-4o-mini") ||
          m.family.includes("gpt-3.5") ||
          m.name.toLowerCase().includes("mini"),
      );

      const selectedModel = preferredModel ?? models[0];
      logger.debug(
        `[TurnCharacterizer] Selected model: ${selectedModel?.name ?? "none"} (${selectedModel?.family ?? "unknown"})`,
      );
      return selectedModel ?? null;
    } catch (error) {
      logger.debug(
        `[TurnCharacterizer] Failed to select model: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Send a request with a proper timeout via CancellationTokenSource.
   *
   * The CancellationTokenSource.token is passed directly to sendRequest,
   * so cancelling it actually aborts the in-flight request and stream iteration.
   */
  private async sendRequestWithTimeout(
    model: vscode.LanguageModelChat,
    messages: vscode.LanguageModelChatMessage[],
  ): Promise<string | undefined> {
    const cts = new vscode.CancellationTokenSource();
    const timeoutId = setTimeout(() => {
      cts.cancel();
    }, CHARACTERIZATION_TIMEOUT_MS);

    try {
      const response = await model.sendRequest(messages, {}, cts.token);

      let result = "";
      for await (const part of response.text) {
        result += part;
        // Characterizations should be very short — bail early if too long
        if (result.length > 100) {
          break;
        }
      }

      return result;
    } catch (error) {
      if (
        error instanceof vscode.CancellationError ||
        (error instanceof Error && error.message.includes("cancelled"))
      ) {
        logger.debug("[TurnCharacterizer] Request timed out");
        throw new Error("Request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      cts.dispose();
    }
  }

  /**
   * Clean up the generated characterization.
   */
  private cleanCharacterization(text: string): string {
    return (
      text
        // Remove leading/trailing quotes
        .replace(/^["']|["']$/g, "")
        // Collapse whitespace
        .replace(/\s+/g, " ")
        .trim()
        // Truncate to reasonable length
        .slice(0, 60)
    );
  }

  /**
   * Clear the cached model (useful for testing or when models change).
   */
  clearCache(): void {
    this.cachedModel = null;
    this.modelSelectionPromise = null;
  }
}

/** Simple sleep helper for retry backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Singleton instance of the turn characterizer.
 */
let turnCharacterizerInstance: TurnCharacterizer | null = null;

/**
 * Get the singleton turn characterizer instance.
 */
export function getTurnCharacterizer(): TurnCharacterizer {
  turnCharacterizerInstance ??= new TurnCharacterizer();
  return turnCharacterizerInstance;
}
