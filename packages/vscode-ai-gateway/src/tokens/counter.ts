import * as crypto from "node:crypto";
import { getEncoding } from "js-tiktoken";
import * as vscode from "vscode";
import { logger } from "../logger";
import { tryStringify } from "../utils/serialize.js";
import { LRUCache } from "./lru-cache";

interface Encoding {
  /**
   * Encode text to tokens.
   * @param text - The text to encode
   * @param allowedSpecial - Special tokens to allow (use "all" to allow all special tokens)
   * @param disallowedSpecial - Special tokens to disallow (use "all" to disallow all)
   */
  encode: (
    text: string,
    allowedSpecial?: string[] | "all",
    disallowedSpecial?: string[] | "all",
  ) => number[];
  free?: () => void;
}

const FALLBACK_CHARS_PER_TOKEN = 3.5;

/**
 * Structural overhead for system prompt (Anthropic SDK wrapping).
 * Based on GCMP research: system message formatting adds ~28 tokens.
 */
const SYSTEM_PROMPT_OVERHEAD = 28;

/**
 * Base overhead for the tools array structure.
 */
const TOOLS_BASE_OVERHEAD = 16;

/**
 * Per-tool structural overhead.
 */
const PER_TOOL_OVERHEAD = 8;

/**
 * Safety multiplier for tool token estimates.
 * From official vscode-copilot-chat implementation.
 */
const TOOL_SAFETY_MULTIPLIER = 1.1;

export class TokenCounter {
  private encodings = new Map<string, Encoding>();
  private textCache = new LRUCache<number>(5000);

  estimateTextTokens(text: string, modelFamily: string): number {
    if (!text) return 0;
    const textHash = crypto
      .createHash("sha256")
      .update(text)
      .digest("hex")
      .slice(0, 16);
    const cacheKey = `${modelFamily}:${textHash}`;
    const cached = this.textCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const encoding = this.getEncodingForFamily(modelFamily);
    if (encoding) {
      // Allow all special tokens to be encoded - they may appear in tool outputs,
      // summarized conversations, or user-provided content. Disallowing them causes
      // errors like "The text contains a special token that is not allowed: <|endoftext|>"
      const count = encoding.encode(text, "all", []).length;
      logger.trace(
        `Text token estimate: ${count.toString()} tokens for ${text.length.toString()} chars (family: ${modelFamily})`,
      );
      this.textCache.put(cacheKey, count);
      return count;
    }
    const count = this.estimateByChars(text);
    logger.trace(
      `Text token estimate: ${count.toString()} tokens for ${text.length.toString()} chars (family: ${modelFamily})`,
    );
    this.textCache.put(cacheKey, count);
    return count;
  }

  estimateMessageTokens(
    message: vscode.LanguageModelChatMessage,
    modelFamily: string,
  ): number {
    let total = 0;
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        total += this.estimateTextTokens(part.value, modelFamily);
      } else if (part instanceof vscode.LanguageModelDataPart) {
        if (part.mimeType.startsWith("image/")) {
          total += this.estimateImageTokens(modelFamily, part);
        } else {
          const decoded = new TextDecoder().decode(part.data);
          total += this.estimateTextTokens(decoded, modelFamily);
        }
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        total += this.estimateToolCallTokens(part, modelFamily);
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        total += this.estimateToolResultTokens(part, modelFamily);
      } else {
        const serializedText = this.extractSerializedText(part);
        if (serializedText !== undefined) {
          total += this.estimateTextTokens(serializedText, modelFamily);
          continue;
        }
        if (this.isSerializedDataPart(part)) {
          total += this.estimateSerializedDataTokens(part, modelFamily);
          continue;
        }
        if (this.isSerializedToolCallPart(part)) {
          total += this.estimateSerializedToolCallTokens(part, modelFamily);
          continue;
        }
        if (this.isSerializedToolResultPart(part)) {
          total += this.estimateSerializedToolResultTokens(part, modelFamily);
        }
      }
    }
    logger.trace(
      `Message token estimate: ${total.toString()} tokens (family: ${modelFamily})`,
    );
    return total;
  }

  applySafetyMargin(tokens: number, margin: number): number {
    const result = Math.ceil(tokens * (1 + margin));
    logger.trace(
      `Applied ${(margin * 100).toString()}% safety margin: ${tokens.toString()} -> ${result.toString()}`,
    );
    return result;
  }

  /**
   * Count tokens for tool schemas.
   *
   * Formula from GCMP research: 16 base + 8/tool + content × 1.1
   * This is CRITICAL - tool schemas can be 50k+ tokens and are the
   * primary cause of token underestimation.
   */
  countToolsTokens(
    tools:
      | readonly { name: string; description?: string; inputSchema?: unknown }[]
      | undefined,
    modelFamily: string,
  ): number {
    if (!tools || tools.length === 0) return 0;

    let numTokens = TOOLS_BASE_OVERHEAD;

    for (const tool of tools) {
      numTokens += PER_TOOL_OVERHEAD;
      numTokens += this.estimateTextTokens(tool.name, modelFamily);
      numTokens += this.estimateTextTokens(tool.description ?? "", modelFamily);
      numTokens += this.estimateTextTokens(
        JSON.stringify(tool.inputSchema ?? {}),
        modelFamily,
      );
    }

    const result = Math.ceil(numTokens * TOOL_SAFETY_MULTIPLIER);
    logger.debug(
      `Tool schema token estimate: ${result.toString()} tokens for ${tools.length.toString()} tools (family: ${modelFamily})`,
    );
    return result;
  }

  /**
   * Count tokens for system prompt including structural overhead.
   *
   * The 28-token overhead accounts for Anthropic SDK system message
   * formatting and structural wrapping.
   */
  countSystemPromptTokens(
    systemPrompt: string | undefined,
    modelFamily: string,
  ): number {
    if (!systemPrompt) return 0;

    const textTokens = this.estimateTextTokens(systemPrompt, modelFamily);
    const result = textTokens + SYSTEM_PROMPT_OVERHEAD;
    logger.debug(
      `System prompt token estimate: ${result.toString()} tokens (${textTokens.toString()} text + ${SYSTEM_PROMPT_OVERHEAD.toString()} overhead)`,
    );
    return result;
  }

  usesCharacterFallback(modelFamily: string): boolean {
    const fallback = this.getEncodingForFamily(modelFamily) === undefined;
    if (fallback) {
      logger.debug(`Using character fallback for family: ${modelFamily}`);
    }
    return fallback;
  }

  private estimateByChars(text: string): number {
    return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN);
  }

  private estimateToolCallTokens(
    part: vscode.LanguageModelToolCallPart,
    modelFamily: string,
  ): number {
    // Use tryStringify to handle potential circular refs in VS Code objects
    const inputJson = tryStringify(part.input);
    const payload = `${part.name}\n${inputJson}`;
    return this.estimateTextTokens(payload, modelFamily) + 4;
  }

  private estimateToolResultTokens(
    part: vscode.LanguageModelToolResultPart,
    modelFamily: string,
  ): number {
    let total = this.estimateTextTokens(part.callId, modelFamily) + 4;
    for (const resultPart of part.content) {
      if (
        typeof resultPart === "object" &&
        resultPart !== null &&
        "value" in resultPart
      ) {
        total += this.estimateTextTokens(String(resultPart.value), modelFamily);
      }
    }
    return total;
  }

  private estimateImageTokens(
    modelFamily: string,
    imagePart: vscode.LanguageModelDataPart,
  ): number {
    return this.estimateImageTokensFromBytes(modelFamily, imagePart.data);
  }

  private estimateImageTokensFromBytes(
    modelFamily: string,
    data: { byteLength: number },
  ): number {
    const family = modelFamily.toLowerCase();

    if (family.includes("anthropic") || family.includes("claude")) {
      return 1600;
    }

    const dataSize = data.byteLength;
    const estimatedPixels = dataSize / 3;
    const estimatedDimension = Math.sqrt(estimatedPixels);
    const scaledDimension = Math.min(estimatedDimension, 2048);
    const tilesPerSide = Math.ceil(scaledDimension / 512);
    const totalTiles = tilesPerSide * tilesPerSide;
    const openAITokens = 85 + totalTiles * 85;

    return Math.min(openAITokens, 1700);
  }

  private extractSerializedText(part: unknown): string | undefined {
    if (typeof part !== "object" || part === null) return undefined;
    if (
      "value" in part &&
      typeof (part as { value?: unknown }).value === "string"
    ) {
      return (part as { value: string }).value;
    }
    if (
      "type" in part &&
      (part as { type?: unknown }).type === "text" &&
      "text" in part &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      return (part as { text: string }).text;
    }
    return undefined;
  }

  private isSerializedDataPart(
    part: unknown,
  ): part is { mimeType: string; data: unknown } {
    return (
      typeof part === "object" &&
      part !== null &&
      "mimeType" in part &&
      typeof (part as { mimeType?: unknown }).mimeType === "string" &&
      "data" in part
    );
  }

  private estimateSerializedDataTokens(
    part: { mimeType: string; data: unknown },
    modelFamily: string,
  ): number {
    if (part.mimeType.startsWith("image/")) {
      const byteLength = this.getDataByteLength(part.data);
      if (byteLength !== undefined) {
        return this.estimateImageTokensFromBytes(modelFamily, { byteLength });
      }
      return 0;
    }

    const decoded = this.decodeSerializedData(part.data);
    return decoded ? this.estimateTextTokens(decoded, modelFamily) : 0;
  }

  private isSerializedToolCallPart(
    part: unknown,
  ): part is { name: string; input?: unknown } {
    return (
      typeof part === "object" &&
      part !== null &&
      "name" in part &&
      typeof (part as { name?: unknown }).name === "string" &&
      "input" in part
    );
  }

  private estimateSerializedToolCallTokens(
    part: { name: string; input?: unknown },
    modelFamily: string,
  ): number {
    const inputJson = tryStringify(part.input);
    const payload = `${part.name}\n${inputJson}`;
    return this.estimateTextTokens(payload, modelFamily) + 4;
  }

  private isSerializedToolResultPart(
    part: unknown,
  ): part is { callId: string; content?: unknown } {
    return (
      typeof part === "object" &&
      part !== null &&
      "callId" in part &&
      typeof (part as { callId?: unknown }).callId === "string" &&
      "content" in part
    );
  }

  private estimateSerializedToolResultTokens(
    part: { callId: string; content?: unknown },
    modelFamily: string,
  ): number {
    let total = this.estimateTextTokens(part.callId, modelFamily) + 4;
    const { content } = part;

    if (Array.isArray(content)) {
      for (const resultPart of content) {
        const text = this.extractSerializedText(resultPart);
        if (text !== undefined) {
          total += this.estimateTextTokens(text, modelFamily);
        } else if (
          typeof resultPart === "object" &&
          resultPart !== null &&
          "value" in resultPart
        ) {
          total += this.estimateTextTokens(
            String((resultPart as { value?: unknown }).value),
            modelFamily,
          );
        }
      }
    } else if (content !== undefined) {
      const text =
        this.extractSerializedText(content) ??
        (typeof content === "string" ? content : undefined);
      if (text !== undefined) {
        total += this.estimateTextTokens(text, modelFamily);
      }
    }

    return total;
  }

  private getDataByteLength(data: unknown): number | undefined {
    if (typeof data === "string") {
      return data.length;
    }
    if (data instanceof ArrayBuffer) {
      return data.byteLength;
    }
    if (ArrayBuffer.isView(data)) {
      return data.byteLength;
    }
    if (
      typeof data === "object" &&
      data !== null &&
      "byteLength" in data &&
      typeof (data as { byteLength?: unknown }).byteLength === "number"
    ) {
      return (data as { byteLength: number }).byteLength;
    }
    if (
      typeof data === "object" &&
      data !== null &&
      "length" in data &&
      typeof (data as { length?: unknown }).length === "number"
    ) {
      return (data as { length: number }).length;
    }
    return undefined;
  }

  private decodeSerializedData(data: unknown): string | undefined {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) {
      return new TextDecoder().decode(new Uint8Array(data));
    }
    if (ArrayBuffer.isView(data)) {
      return new TextDecoder().decode(data);
    }
    if (Array.isArray(data)) {
      return new TextDecoder().decode(new Uint8Array(data));
    }
    return undefined;
  }

  private getEncodingForFamily(modelFamily: string): Encoding | undefined {
    const encodingName = this.resolveEncodingName(modelFamily);
    if (encodingName === undefined) {
      // All model families are approximated with tiktoken encodings.
      // Character fallback only applies if the encoding lookup fails.
      return undefined;
    }
    if (this.encodings.has(encodingName)) {
      return this.encodings.get(encodingName);
    }
    try {
      const encoding = getEncoding(encodingName) as Encoding;
      this.encodings.set(encodingName, encoding);
      return encoding;
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve tiktoken encoding name for a model family.
   *
   * NOTE: This uses OpenAI's tiktoken encodings as an approximation for ALL models.
   * Non-OpenAI models (Claude, Gemini, Llama, etc.) use proprietary tokenizers that
   * can differ by 10-30% from tiktoken. However, for status bar estimation purposes,
   * this approximation is acceptable - users need "am I near the limit?" not exact counts.
   *
   * Alternatives considered:
   * - Character fallback (~3.5 chars/token): Less consistent, not more accurate
   * - Model-specific tokenizers: Heavy dependencies (WASM), not all publicly available
   * - API-based counting: Adds latency and cost
   */
  private resolveEncodingName(
    modelFamily: string,
  ): "o200k_base" | "cl100k_base" {
    const family = modelFamily.toLowerCase();

    // GPT-4o and O1/O3 series use o200k_base (newer, larger vocabulary)
    if (
      family.includes("gpt-4o") ||
      family.includes("o1-") ||
      family.includes("o3-") ||
      family === "o1" ||
      family === "o3"
    ) {
      return "o200k_base";
    }

    // All other models use cl100k_base as a reasonable approximation
    // This includes: GPT-4, GPT-3.5, Claude, Gemini, Llama, Mistral, etc.
    return "cl100k_base";
  }
}
