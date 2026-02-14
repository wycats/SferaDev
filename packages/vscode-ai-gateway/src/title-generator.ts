import * as vscode from "vscode";
import { logger } from "./logger";

/**
 * Maximum length of the first user message to send to the title generator.
 * Longer messages are truncated to save tokens.
 */
const MAX_MESSAGE_LENGTH = 200;

/**
 * Timeout for title generation requests (ms).
 * If the model takes longer, we fall back to the preview.
 */
const TITLE_GENERATION_TIMEOUT_MS = 5000;

/**
 * System prompt for title generation.
 * Kept minimal to reduce token usage.
 */
const TITLE_SYSTEM_PROMPT = `Generate a concise 3-5 word title for this conversation. Output ONLY the title, no quotes or punctuation.`;

/**
 * Generates a short title for a conversation using a Copilot model.
 *
 * This service uses VS Code's Language Model API to find a free Copilot model
 * and generate a concise title from the first user message.
 *
 * @example
 * ```ts
 * const generator = new TitleGenerator();
 * const title = await generator.generateTitle("Fix the bug in the login form where...");
 * // Returns: "Login Form Bug Fix" or undefined if generation fails
 * ```
 */
export class TitleGenerator {
  private cachedModel: vscode.LanguageModelChat | null = null;
  private modelSelectionPromise: Promise<vscode.LanguageModelChat | null> | null =
    null;

  /**
   * Generate a title for a conversation based on the first user message.
   *
   * @param firstUserMessage The first user message in the conversation
   * @returns A short title (3-5 words) or undefined if generation fails
   */
  async generateTitle(firstUserMessage: string): Promise<string | undefined> {
    try {
      const model = await this.getModel();
      if (!model) {
        logger.debug("[TitleGenerator] No Copilot model available");
        return undefined;
      }

      // Truncate long messages to save tokens
      const truncatedMessage =
        firstUserMessage.length > MAX_MESSAGE_LENGTH
          ? firstUserMessage.slice(0, MAX_MESSAGE_LENGTH) + "..."
          : firstUserMessage;

      // Create the request
      const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(
          `${TITLE_SYSTEM_PROMPT}\n\nUser message: ${truncatedMessage}`,
        ),
      ];

      // Send request with timeout
      const title = await this.sendRequestWithTimeout(model, messages);
      if (!title) {
        return undefined;
      }

      // Clean up the response (remove quotes, extra whitespace, etc.)
      const cleanedTitle = this.cleanTitle(title);
      logger.debug(`[TitleGenerator] Generated title: "${cleanedTitle}"`);
      return cleanedTitle;
    } catch (error) {
      logger.debug(
        `[TitleGenerator] Failed to generate title: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /**
   * Get a Copilot model for title generation.
   * Caches the model selection to avoid repeated lookups.
   */
  private async getModel(): Promise<vscode.LanguageModelChat | null> {
    // Return cached model if available
    if (this.cachedModel) {
      return this.cachedModel;
    }

    // Avoid concurrent model selection
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
   * Select a suitable Copilot model for title generation.
   * Prefers smaller/faster models like gpt-4o-mini.
   */
  private async selectModel(): Promise<vscode.LanguageModelChat | null> {
    try {
      // Try to get Copilot models
      const models = await vscode.lm.selectChatModels({ vendor: "copilot" });

      if (models.length === 0) {
        logger.debug("[TitleGenerator] No Copilot models available");
        return null;
      }

      // Prefer smaller/faster models for title generation
      // Look for gpt-4o-mini or similar
      const preferredModel = models.find(
        (m) =>
          m.family.includes("gpt-4o-mini") ||
          m.family.includes("gpt-3.5") ||
          m.name.toLowerCase().includes("mini"),
      );

      const selectedModel = preferredModel ?? models[0];
      logger.debug(
        `[TitleGenerator] Selected model: ${selectedModel?.name ?? "none"} (${selectedModel?.family ?? "unknown"})`,
      );
      return selectedModel ?? null;
    } catch (error) {
      logger.debug(
        `[TitleGenerator] Failed to select model: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Send a request to the model with a timeout.
   */
  private async sendRequestWithTimeout(
    model: vscode.LanguageModelChat,
    messages: vscode.LanguageModelChatMessage[],
  ): Promise<string | undefined> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, TITLE_GENERATION_TIMEOUT_MS);

    try {
      const response = await model.sendRequest(
        messages,
        {},
        new vscode.CancellationTokenSource().token,
      );

      let result = "";
      for await (const part of response.text) {
        result += part;
        // Stop early if we have enough text (titles should be short)
        if (result.length > 100) {
          break;
        }
      }

      return result;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        logger.debug("[TitleGenerator] Request timed out");
      }
      return undefined;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Clean up the generated title.
   * Removes quotes, extra whitespace, and truncates if too long.
   */
  private cleanTitle(title: string): string {
    return (
      title
        // Remove leading/trailing quotes
        .replace(/^["']|["']$/g, "")
        // Remove "Title:" prefix if present
        .replace(/^title:\s*/i, "")
        // Collapse whitespace
        .replace(/\s+/g, " ")
        .trim()
        // Truncate to reasonable length (max 50 chars)
        .slice(0, 50)
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
 * Singleton instance of the title generator.
 */
let titleGeneratorInstance: TitleGenerator | null = null;

/**
 * Get the singleton title generator instance.
 */
export function getTitleGenerator(): TitleGenerator {
  if (!titleGeneratorInstance) {
    titleGeneratorInstance = new TitleGenerator();
  }
  return titleGeneratorInstance;
}
