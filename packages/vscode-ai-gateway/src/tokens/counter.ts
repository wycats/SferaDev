import * as vscode from "vscode";
import { logger } from "../logger";
import { tryStringify } from "../utils/serialize.js";
import { isMetadataMime } from "../utils/stateful-marker.js";
import { LRUCache } from "./lru-cache";
import type { Tokenizer as TokenizerInstance } from "ai-tokenizer";

type TokenizerConstructor = typeof import("ai-tokenizer").Tokenizer;
type EncodingModule =
  | typeof import("ai-tokenizer/encoding/o200k_base")
  | typeof import("ai-tokenizer/encoding/claude");

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
 *
 * Update 2026-02-07: Anthropic models require a higher multiplier (~1.4)
 * due to XML formatting overhead for tool schemas.
 */
const TOOL_SAFETY_MULTIPLIER = 1.1;
const ANTHROPIC_TOOL_SCHEMA_MULTIPLIER = 1.4;

/**
 * Anthropic XML overhead multiplier for tool calls and results in conversation.
 * Lower than schema multiplier because call/result XML wrapping is lighter
 * (<tool_use>/<tool_result> tags) vs full schema formatting.
 *
 * Empirically calibrated: 1.4x overcounts by ~8%, 1.0x undercounts by ~14%.
 * Ideal = 1.25x (within ~2% of actual across 150+ message conversations).
 * GCMP uses 1.5x on tool_calls only (no multiplier on results).
 */
const ANTHROPIC_TOOL_CALL_MULTIPLIER = 1.25;

/**
 * Per-message structural overhead (role, separator tokens).
 */
const MESSAGE_OVERHEAD = 3;

/**
 * Token counter using ai-tokenizer with model-family encoding dispatch.
 *
 * Uses o200k_base for OpenAI/general models and claude encoding for
 * Anthropic models. Replaces the previous js-tiktoken + delta estimation
 * infrastructure with direct tokenizer calls (RFC 00063 Phase 2).
 */
export class TokenCounter {
  private static ready: Promise<void> | null = null;
  private static loadError: Error | null = null;
  private static tokenizerCtor: TokenizerConstructor | null = null;
  private static encodings: {
    o200k_base?: EncodingModule;
    claude?: EncodingModule;
  } = {};

  private tokenizers = new Map<string, TokenizerInstance>();
  private textCache = new LRUCache<number>(5000);

  constructor() {
    TokenCounter.ensureLoading();
  }

  /**
   * Start loading tokenizer dependencies in the background.
   */
  initialize(): Promise<void> {
    return TokenCounter.initialize();
  }

  /**
   * Count tokens for a text string.
   */
  estimateTextTokens(text: string, modelFamily: string): number {
    if (!text) return 0;

    // Use a fast cache key based on encoding + text length + content prefix/suffix.
    // Collisions are theoretically possible but vanishingly unlikely in practice.
    const encodingName = this.resolveEncodingName(modelFamily);
    const cacheKey = `${encodingName}:${text.length.toString()}:${text.slice(0, 64)}:${text.slice(-32)}`;
    const cached = this.textCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const tokenizer = this.getTokenizerForFamily(modelFamily);
    if (!tokenizer) {
      return this.estimateFallbackTokens(text);
    }

    const count = tokenizer.count(text);

    logger.trace(
      `Text token estimate: ${count.toString()} tokens for ${text.length.toString()} chars (family: ${modelFamily})`,
    );
    this.textCache.put(cacheKey, count);
    return count;
  }

  /**
   * Count tokens for a chat message including all content parts.
   */
  estimateMessageTokens(
    message: vscode.LanguageModelChatMessage,
    modelFamily: string,
  ): number {
    let total = 0;
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        total += this.estimateTextTokens(part.value, modelFamily);
      } else if (part instanceof vscode.LanguageModelDataPart) {
        if (isMetadataMime(part.mimeType)) {
          continue;
        }
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
          continue;
        }
        const protoName =
          (Object.getPrototypeOf(part) as { constructor?: { name?: string } })
            .constructor?.name ?? "null";
        logger.warn(
          `Unrecognized message part type. Keys: [${Object.keys(part as object).join(", ")}], ` +
            `Proto: ${protoName}, ` +
            `hasCallId: ${"callId" in (part as object)}, hasContent: ${"content" in (part as object)}`,
        );
      }
    }

    // Add per-message structural overhead
    total += MESSAGE_OVERHEAD;

    logger.trace(
      `Message token estimate: ${total.toString()} tokens (family: ${modelFamily})`,
    );
    return total;
  }

  /**
   * Count tokens for tool schemas.
   *
   * Formula from GCMP research: 16 base + 8/tool + content × multiplier
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

    const multiplier = this.isAnthropicFamily(modelFamily)
      ? ANTHROPIC_TOOL_SCHEMA_MULTIPLIER
      : TOOL_SAFETY_MULTIPLIER;

    const result = Math.ceil(numTokens * multiplier);
    logger.debug(
      `Tool schema token estimate: ${result.toString()} tokens for ${tools.length.toString()} tools (family: ${modelFamily}, multiplier: ${multiplier})`,
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

  /**
   * Get the tokenizer for a model family, lazily initialized.
   */
  private getTokenizerForFamily(
    modelFamily: string,
  ): TokenizerInstance | undefined {
    const encodingName = this.resolveEncodingName(modelFamily);
    const existing = this.tokenizers.get(encodingName);
    if (existing) {
      return existing;
    }
    if (!TokenCounter.isLoaded() || !TokenCounter.tokenizerCtor) {
      return undefined;
    }

    const encoding =
      encodingName === "claude"
        ? TokenCounter.encodings.claude
        : TokenCounter.encodings.o200k_base;
    if (!encoding) {
      return undefined;
    }

    const tokenizer = new TokenCounter.tokenizerCtor(encoding);
    this.tokenizers.set(encodingName, tokenizer);
    return tokenizer;
  }

  private static initialize(): Promise<void> {
    if (!TokenCounter.ready) {
      const loadPromise = (async () => {
        const [{ Tokenizer }, o200kBase, claudeEncoding] = await Promise.all([
          import("ai-tokenizer"),
          import("ai-tokenizer/encoding/o200k_base"),
          import("ai-tokenizer/encoding/claude"),
        ]);
        TokenCounter.tokenizerCtor = Tokenizer;
        TokenCounter.encodings = {
          o200k_base: o200kBase,
          claude: claudeEncoding,
        };
      })();

      loadPromise.catch((error: unknown) => {
        TokenCounter.loadError =
          error instanceof Error ? error : new Error(String(error));
        logger.warn(
          "Failed to load ai-tokenizer; falling back to heuristic token estimates.",
          TokenCounter.loadError,
        );
      });

      TokenCounter.ready = loadPromise;
    }

    return TokenCounter.ready;
  }

  private static ensureLoading(): void {
    if (!TokenCounter.ready) {
      void TokenCounter.initialize();
    }
  }

  private static isLoaded(): boolean {
    return Boolean(
      TokenCounter.tokenizerCtor &&
      TokenCounter.encodings.o200k_base &&
      TokenCounter.encodings.claude,
    );
  }

  private estimateFallbackTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Resolve encoding name for a model family.
   *
   * Claude/Anthropic models use the dedicated claude encoding (~97-99% accuracy).
   * All other models use o200k_base (the most modern OpenAI encoding, which is
   * a reasonable approximation even for non-OpenAI models like Gemini, Llama, etc.).
   */
  private resolveEncodingName(modelFamily: string): "o200k_base" | "claude" {
    return this.isAnthropicFamily(modelFamily) ? "claude" : "o200k_base";
  }

  private isAnthropicFamily(modelFamily: string): boolean {
    const family = modelFamily.toLowerCase();
    return family.includes("claude") || family.includes("anthropic");
  }

  private estimateToolCallTokens(
    part: vscode.LanguageModelToolCallPart,
    modelFamily: string,
  ): number {
    const inputJson = tryStringify(part.input);
    const payload = `${part.name}\n${inputJson}`;
    let tokens = this.estimateTextTokens(payload, modelFamily) + 4;
    // Count callId if present (Anthropic includes it in XML formatting)
    if (part.callId) {
      tokens += this.estimateTextTokens(part.callId, modelFamily);
    }
    // Anthropic wraps tool calls in XML, adding ~40% overhead
    if (this.isAnthropicFamily(modelFamily)) {
      tokens = Math.ceil(tokens * ANTHROPIC_TOOL_CALL_MULTIPLIER);
    }
    return tokens;
  }

  private estimateToolResultTokens(
    part: vscode.LanguageModelToolResultPart,
    modelFamily: string,
  ): number {
    let total = this.estimateTextTokens(part.callId, modelFamily) + 4;
    for (const resultPart of part.content) {
      const text = this.extractSerializedText(resultPart);
      if (text !== undefined) {
        total += this.estimateTextTokens(text, modelFamily);
        continue;
      }

      if (this.isSerializedDataPart(resultPart)) {
        total += this.estimateSerializedDataTokens(resultPart, modelFamily);
        continue;
      }

      if (typeof resultPart === "string") {
        total += this.estimateTextTokens(resultPart, modelFamily);
        continue;
      }

      if (resultPart instanceof vscode.LanguageModelDataPart) {
        if (resultPart.mimeType.startsWith("image/")) {
          total += this.estimateImageTokens(modelFamily, resultPart);
        } else {
          const decoded = new TextDecoder().decode(resultPart.data);
          total += this.estimateTextTokens(decoded, modelFamily);
        }
        continue;
      }
    }
    // Anthropic wraps tool results in XML, adding ~25% overhead
    if (this.isAnthropicFamily(modelFamily)) {
      total = Math.ceil(total * ANTHROPIC_TOOL_CALL_MULTIPLIER);
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
    if (this.isAnthropicFamily(modelFamily)) {
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
    if (isMetadataMime(part.mimeType)) {
      return 0;
    }
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
    part: { name: string; input?: unknown; callId?: string },
    modelFamily: string,
  ): number {
    const inputJson = tryStringify(part.input);
    const payload = `${part.name}\n${inputJson}`;
    let tokens = this.estimateTextTokens(payload, modelFamily) + 4;
    if (part.callId) {
      tokens += this.estimateTextTokens(part.callId, modelFamily);
    }
    // Anthropic wraps tool calls in XML, adding ~40% overhead
    if (this.isAnthropicFamily(modelFamily)) {
      tokens = Math.ceil(tokens * ANTHROPIC_TOOL_CALL_MULTIPLIER);
    }
    return tokens;
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

    // Anthropic wraps tool results in XML, adding ~25% overhead
    if (this.isAnthropicFamily(modelFamily)) {
      total = Math.ceil(total * ANTHROPIC_TOOL_CALL_MULTIPLIER);
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
}
