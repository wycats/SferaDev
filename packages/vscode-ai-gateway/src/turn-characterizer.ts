import * as vscode from "vscode";
import { logger } from "./logger";

/**
 * Maximum length of the assistant response text to send for characterization.
 * Longer texts are truncated to save tokens.
 */
const MAX_TEXT_LENGTH = 500;

/**
 * Timeout for characterization requests (ms).
 */
const CHARACTERIZATION_TIMEOUT_MS = 5000;

/**
 * System prompt for turn characterization.
 * Kept minimal to reduce token usage.
 */
const CHARACTERIZATION_SYSTEM_PROMPT = `Summarize what happened in this assistant turn in 3-6 words. Output ONLY the summary, no quotes or punctuation. Examples: "Refactored auth middleware", "Fixed login form bug", "Added unit tests".`;

/**
 * Generates a concise characterization for a conversation turn using a Copilot model.
 *
 * Uses VS Code's Language Model API to find a free Copilot model
 * and generate a short label from the assistant's response text.
 *
 * Follows the same pattern as TitleGenerator.
 *
 * @example
 * ```ts
 * const characterizer = getTurnCharacterizer();
 * const label = await characterizer.characterize("I've refactored the auth middleware to use...");
 * // Returns: "Refactored auth middleware" or undefined if generation fails
 * ```
 */
export class TurnCharacterizer {
  private cachedModel: vscode.LanguageModelChat | null = null;
  private modelSelectionPromise: Promise<vscode.LanguageModelChat | null> | null =
    null;

  /**
   * Generate a characterization for a turn based on the assistant response text.
   *
   * @param responseText The assistant's response text for the turn
   * @returns A short characterization (3-6 words) or undefined if generation fails
   */
  async characterize(responseText: string): Promise<string | undefined> {
    try {
      // Skip empty or very short responses
      if (!responseText || responseText.trim().length < 10) {
        return undefined;
      }

      const model = await this.getModel();
      if (!model) {
        logger.debug("[TurnCharacterizer] No Copilot model available");
        return undefined;
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

      const result = await this.sendRequestWithTimeout(model, messages);
      if (!result) {
        return undefined;
      }

      const cleaned = this.cleanCharacterization(result);
      logger.debug(
        `[TurnCharacterizer] Generated characterization: "${cleaned}"`,
      );
      return cleaned;
    } catch (error) {
      logger.debug(
        `[TurnCharacterizer] Failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
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
   * Send a request with a timeout.
   */
  private async sendRequestWithTimeout(
    model: vscode.LanguageModelChat,
    messages: vscode.LanguageModelChatMessage[],
  ): Promise<string | undefined> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, CHARACTERIZATION_TIMEOUT_MS);

    try {
      const response = await model.sendRequest(
        messages,
        {},
        new vscode.CancellationTokenSource().token,
      );

      let result = "";
      for await (const part of response.text) {
        result += part;
        // Characterizations should be very short
        if (result.length > 100) {
          break;
        }
      }

      return result;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        logger.debug("[TurnCharacterizer] Request timed out");
      }
      return undefined;
    } finally {
      clearTimeout(timeoutId);
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
