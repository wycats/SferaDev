# RFC 003: Core Streaming Package Extraction

**Status:** Draft  
**Author:** Vercel AI Team  
**Created:** 2026-01-27  
**Updated:** 2026-01-27

## Summary

Extract the stream chunk handling, token estimation, and VS Code adapter logic from the extension into a reusable package `@vercel/ai-gateway-vscode`, enabling other Vercel AI SDK consumers to build VS Code integrations with consistent behavior.

## Motivation

The current `packages/vscode-ai-gateway/src/provider.ts` contains ~750 lines of sophisticated logic for:

1. **Stream chunk mapping**: Converting Vercel AI SDK's `fullStream` chunks to VS Code `LanguageModelResponsePart`
2. **Token estimation**: Hybrid approach combining actual usage tracking with character-based estimation
3. **MIME type handling**: Factory method selection for `LanguageModelDataPart`
4. **Provider-specific options**: Anthropic context management, reasoning chunk handling
5. **Message conversion**: Mapping VS Code messages to AI SDK format with tool call/result handling

This logic is valuable beyond the Vercel AI Gateway extension. Other teams building VS Code integrations with the Vercel AI SDK would benefit from:

- Consistent stream handling behavior
- Battle-tested token estimation
- Proper VS Code API usage patterns
- Reduced boilerplate

## Detailed Design

### Package Structure

```
@vercel/ai-gateway-vscode/
├── src/
│   ├── index.ts                    # Public exports
│   ├── adapter/
│   │   ├── stream-adapter.ts       # VSCodeStreamAdapter class
│   │   ├── chunk-handlers.ts       # Individual chunk type handlers
│   │   └── types.ts                # Adapter types
│   ├── tokens/
│   │   ├── estimator.ts            # HybridTokenEstimator class
│   │   ├── image-tokens.ts         # Image token estimation
│   │   └── types.ts                # Token types
│   ├── messages/
│   │   ├── converter.ts            # Message conversion utilities
│   │   ├── tool-mapping.ts         # Tool call/result mapping
│   │   └── types.ts                # Message types
│   └── utils/
│       ├── mime.ts                 # MIME type validation
│       └── logger.ts               # Logging utilities
├── test/
│   ├── stream-adapter.test.ts
│   ├── token-estimator.test.ts
│   └── message-converter.test.ts
├── package.json
├── tsconfig.json
└── README.md
```

### Core Classes

#### VSCodeStreamAdapter

```typescript
// src/adapter/stream-adapter.ts
import type { TextStreamPart, ToolSet } from "ai";
import type { LanguageModelResponsePart, Progress } from "vscode";

export interface StreamAdapterOptions {
  /** Enable reasoning/thinking chunk forwarding (requires unstable API) */
  enableReasoning?: boolean;
  /** Custom handler for unknown chunk types */
  onUnknownChunk?: (chunk: unknown) => void;
  /** Logger for debug output */
  logger?: AdapterLogger;
}

export interface AdapterLogger {
  debug(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface StreamUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * Adapts Vercel AI SDK fullStream to VS Code LanguageModelResponsePart.
 *
 * Uses fullStream instead of toUIMessageStream() to access tool-call events
 * that are hidden by the UI stream.
 */
export class VSCodeStreamAdapter {
  private options: Required<StreamAdapterOptions>;
  private usage: StreamUsage = { inputTokens: null, outputTokens: null };

  constructor(options: StreamAdapterOptions = {}) {
    this.options = {
      enableReasoning: options.enableReasoning ?? true,
      onUnknownChunk: options.onUnknownChunk ?? (() => {}),
      logger: options.logger ?? console,
    };
  }

  /**
   * Process a full stream and report parts to VS Code progress.
   */
  async processStream(
    stream: AsyncIterable<TextStreamPart<ToolSet>>,
    progress: Progress<LanguageModelResponsePart>,
  ): Promise<StreamUsage> {
    for await (const chunk of stream) {
      this.handleChunk(chunk, progress);
    }
    return this.usage;
  }

  /**
   * Create an async generator that yields VS Code response parts.
   */
  async *adaptStream(
    stream: AsyncIterable<TextStreamPart<ToolSet>>,
  ): AsyncGenerator<LanguageModelResponsePart> {
    for await (const chunk of stream) {
      const part = this.mapChunk(chunk);
      if (part) yield part;
    }
  }

  /**
   * Get usage statistics from the last processed stream.
   */
  getUsage(): StreamUsage {
    return { ...this.usage };
  }

  private handleChunk(
    chunk: TextStreamPart<ToolSet>,
    progress: Progress<LanguageModelResponsePart>,
  ): void {
    const part = this.mapChunk(chunk);
    if (part) {
      progress.report(part);
    }
  }

  private mapChunk(
    chunk: TextStreamPart<ToolSet>,
  ): LanguageModelResponsePart | null {
    switch (chunk.type) {
      case "text-delta":
        return this.handleTextDelta(chunk);
      case "reasoning-delta":
        return this.handleReasoningDelta(chunk);
      case "tool-call":
        return this.handleToolCall(chunk);
      case "file":
        return this.handleFile(chunk);
      case "error":
        return this.handleError(chunk);
      case "finish":
      case "finish-step":
        this.updateUsage(chunk);
        return null;
      default:
        return this.handleUnknown(chunk);
    }
  }

  // ... individual handlers (see detailed implementation below)
}
```

#### HybridTokenEstimator

```typescript
// src/tokens/estimator.ts
import type {
  LanguageModelChatMessage,
  LanguageModelChatInformation,
} from "vscode";

export interface TokenEstimatorOptions {
  /** Characters per token for text estimation (default: 3.5) */
  charsPerToken?: number;
  /** Whether to use conservative estimates (default: true) */
  conservative?: boolean;
  /** Provider-specific overrides */
  providerOverrides?: Record<string, { charsPerToken: number }>;
}

export interface EstimationResult {
  tokens: number;
  method: "actual" | "hybrid" | "estimated";
  confidence: number; // 0-1
}

/**
 * Hybrid token estimator that combines actual usage tracking
 * with character-based estimation.
 */
export class HybridTokenEstimator {
  private options: Required<TokenEstimatorOptions>;
  private lastActualInputTokens: number | null = null;
  private lastMessageCount: number = 0;
  private correctionFactor: number = 1.0;

  constructor(options: TokenEstimatorOptions = {}) {
    this.options = {
      charsPerToken: options.charsPerToken ?? 3.5,
      conservative: options.conservative ?? true,
      providerOverrides: options.providerOverrides ?? {
        anthropic: { charsPerToken: 4.0 },
        openai: { charsPerToken: 3.5 },
        google: { charsPerToken: 4.0 },
      },
    };
  }

  /**
   * Estimate tokens for a single message.
   */
  estimateMessage(
    model: LanguageModelChatInformation,
    message: LanguageModelChatMessage,
  ): number {
    const charsPerToken = this.getCharsPerToken(model);
    let tokens = 0;

    for (const part of message.content) {
      tokens += this.estimatePart(model, part, charsPerToken);
    }

    return Math.ceil(tokens * (this.options.conservative ? 1.1 : 1.0));
  }

  /**
   * Estimate total input tokens for a conversation.
   * Uses hybrid approach if actual data is available.
   */
  estimateConversation(
    model: LanguageModelChatInformation,
    messages: readonly LanguageModelChatMessage[],
  ): EstimationResult {
    // Hybrid estimation: use actual tokens for known messages
    if (
      this.lastActualInputTokens !== null &&
      messages.length > this.lastMessageCount &&
      this.lastMessageCount > 0
    ) {
      const newMessages = messages.slice(this.lastMessageCount);
      let newTokens = 0;
      for (const msg of newMessages) {
        newTokens += this.estimateMessage(model, msg);
      }
      newTokens += newMessages.length * 4; // Message structure overhead

      return {
        tokens: this.lastActualInputTokens + newTokens,
        method: "hybrid",
        confidence: 0.85,
      };
    }

    // Pure estimation
    let total = 0;
    for (const msg of messages) {
      total += this.estimateMessage(model, msg);
    }
    total += messages.length * 4;

    return {
      tokens: Math.ceil(total * this.correctionFactor),
      method: "estimated",
      confidence: 0.7,
    };
  }

  /**
   * Update estimator with actual usage from a completed request.
   */
  calibrate(
    actualInputTokens: number,
    messageCount: number,
    estimatedTokens: number,
  ): void {
    this.lastActualInputTokens = actualInputTokens;
    this.lastMessageCount = messageCount;

    if (estimatedTokens > 0) {
      const newFactor = actualInputTokens / estimatedTokens;
      // Exponential moving average
      this.correctionFactor = this.correctionFactor * 0.7 + newFactor * 0.3;
    }
  }

  /**
   * Reset calibration state (e.g., for new conversation).
   */
  reset(): void {
    this.lastActualInputTokens = null;
    this.lastMessageCount = 0;
    // Keep correction factor as it's learned over time
  }

  private getCharsPerToken(model: LanguageModelChatInformation): number {
    const family = model.family.toLowerCase();
    for (const [provider, config] of Object.entries(
      this.options.providerOverrides,
    )) {
      if (family.includes(provider)) {
        return config.charsPerToken;
      }
    }
    return this.options.charsPerToken;
  }

  private estimatePart(
    model: LanguageModelChatInformation,
    part: unknown,
    charsPerToken: number,
  ): number {
    // Text parts
    if (this.isTextPart(part)) {
      return part.value.length / charsPerToken;
    }

    // Data parts (images, files)
    if (this.isDataPart(part)) {
      return this.estimateImageTokens(model, part);
    }

    // Tool call parts
    if (this.isToolCallPart(part)) {
      const inputJson = JSON.stringify(part.input);
      return (part.name.length + inputJson.length + 50) / charsPerToken;
    }

    // Tool result parts
    if (this.isToolResultPart(part)) {
      let tokens = 20; // Base overhead
      for (const resultPart of part.content) {
        if (
          typeof resultPart === "object" &&
          resultPart &&
          "value" in resultPart
        ) {
          tokens += String(resultPart.value).length / charsPerToken;
        }
      }
      return tokens;
    }

    return 0;
  }

  private estimateImageTokens(
    model: LanguageModelChatInformation,
    part: { data: Uint8Array; mimeType: string },
  ): number {
    const family = model.family.toLowerCase();

    // Anthropic: fixed ~1600 tokens per image
    if (family.includes("anthropic") || family.includes("claude")) {
      return 1600;
    }

    // OpenAI/others: tile-based estimation
    const dataSize = part.data.byteLength;
    const estimatedPixels = dataSize / 3;
    const estimatedDimension = Math.sqrt(estimatedPixels);
    const scaledDimension = Math.min(estimatedDimension, 2048);
    const tilesPerSide = Math.ceil(scaledDimension / 512);
    const totalTiles = tilesPerSide * tilesPerSide;

    return Math.min(85 + totalTiles * 85, 1700);
  }

  // Type guards
  private isTextPart(part: unknown): part is { value: string } {
    return typeof part === "object" && part !== null && "value" in part;
  }

  private isDataPart(
    part: unknown,
  ): part is { data: Uint8Array; mimeType: string } {
    return (
      typeof part === "object" &&
      part !== null &&
      "data" in part &&
      "mimeType" in part
    );
  }

  private isToolCallPart(
    part: unknown,
  ): part is { name: string; callId: string; input: unknown } {
    return (
      typeof part === "object" &&
      part !== null &&
      "name" in part &&
      "callId" in part
    );
  }

  private isToolResultPart(
    part: unknown,
  ): part is { callId: string; content: unknown[] } {
    return (
      typeof part === "object" &&
      part !== null &&
      "callId" in part &&
      "content" in part
    );
  }
}
```

#### MessageConverter

```typescript
// src/messages/converter.ts
import type { ModelMessage } from "ai";
import type { LanguageModelChatMessage } from "vscode";

export interface ConversionOptions {
  /** How to handle images in non-user messages */
  imageInNonUserMessage?: "placeholder" | "skip" | "error";
  /** Logger for warnings */
  logger?: { warn: (msg: string) => void };
}

/**
 * Convert VS Code LanguageModelChatMessage array to AI SDK ModelMessage array.
 */
export function convertMessages(
  messages: readonly LanguageModelChatMessage[],
  options: ConversionOptions = {},
): ModelMessage[] {
  // Build tool name mapping from all messages
  const toolNameMap = buildToolNameMap(messages);

  // Convert each message
  const result = messages
    .flatMap((msg) => convertSingleMessage(msg, toolNameMap, options))
    .filter(isValidMessage);

  // Fix system message placement
  fixSystemMessages(result);

  return result;
}

function buildToolNameMap(
  messages: readonly LanguageModelChatMessage[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const msg of messages) {
    for (const part of msg.content) {
      if (isToolCallPart(part)) {
        map[part.callId] = part.name;
      }
    }
  }
  return map;
}

// ... additional conversion utilities
```

### Package.json

```json
{
  "name": "@vercel/ai-gateway-vscode",
  "version": "1.0.0",
  "description": "VS Code adapter utilities for Vercel AI Gateway",
  "main": "./dist/index.js",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./adapter": {
      "import": "./dist/adapter/index.mjs",
      "require": "./dist/adapter/index.js",
      "types": "./dist/adapter/index.d.ts"
    },
    "./tokens": {
      "import": "./dist/tokens/index.mjs",
      "require": "./dist/tokens/index.js",
      "types": "./dist/tokens/index.d.ts"
    },
    "./messages": {
      "import": "./dist/messages/index.mjs",
      "require": "./dist/messages/index.js",
      "types": "./dist/messages/index.d.ts"
    }
  },
  "peerDependencies": {
    "ai": "^6.0.0",
    "vscode": "^1.108.0"
  },
  "devDependencies": {
    "@types/vscode": "^1.108.0",
    "ai": "^6.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.0.0",
    "vitest": "^2.0.0"
  },
  "keywords": ["vercel", "ai", "vscode", "language-model", "streaming"],
  "repository": {
    "type": "git",
    "url": "https://github.com/vercel/ai-gateway-vscode"
  },
  "license": "MIT"
}
```

### Usage in Extension

```typescript
// packages/vscode-ai-gateway/src/provider.ts
import {
  VSCodeStreamAdapter,
  HybridTokenEstimator,
  convertMessages,
} from "@vercel/ai-gateway-vscode";

export class VercelAIChatModelProvider implements LanguageModelChatProvider {
  private streamAdapter = new VSCodeStreamAdapter({ enableReasoning: true });
  private tokenEstimator = new HybridTokenEstimator({ conservative: true });

  async provideLanguageModelChatResponse(
    model: LanguageModelChatInformation,
    chatMessages: readonly LanguageModelChatMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    progress: Progress<LanguageModelResponsePart>,
    token: CancellationToken,
  ): Promise<void> {
    // Pre-flight token estimation
    const estimation = this.tokenEstimator.estimateConversation(
      model,
      chatMessages,
    );
    if (estimation.tokens > model.maxInputTokens) {
      console.warn(`Estimated ${estimation.tokens} tokens exceeds limit`);
    }

    const response = streamText({
      model: gateway(model.id),
      messages: convertMessages(chatMessages),
      // ...
    });

    // Process stream with adapter
    const usage = await this.streamAdapter.processStream(
      response.fullStream,
      progress,
    );

    // Calibrate estimator with actual usage
    if (usage.inputTokens !== null) {
      this.tokenEstimator.calibrate(
        usage.inputTokens,
        chatMessages.length,
        estimation.tokens,
      );
    }
  }

  async provideTokenCount(
    model: LanguageModelChatInformation,
    text: string | LanguageModelChatMessage,
    _token: CancellationToken,
  ): Promise<number> {
    if (typeof text === "string") {
      return Math.ceil(text.length / 3.5);
    }
    return this.tokenEstimator.estimateMessage(model, text);
  }
}
```

## Drawbacks

1. **Additional dependency**: Extension now depends on external package
2. **Version coordination**: Package and extension versions must be compatible
3. **Abstraction overhead**: Some flexibility lost by using generic adapter
4. **Testing complexity**: Need to test both package and extension integration

## Alternatives

### Alternative 1: Keep Logic in Extension

Don't extract; keep all logic in the extension.

**Rejected because:** Valuable logic can't be reused by other VS Code integrations.

### Alternative 2: Extract to @ai-sdk/vscode

Contribute to the official AI SDK.

**Considered:** Could be a future step, but Vercel-specific package allows faster iteration.

### Alternative 3: Publish as Separate Utilities

Publish individual utilities (stream-adapter, token-estimator) as separate packages.

**Rejected because:** Fragmentation, harder to maintain version compatibility.

## Unresolved Questions

1. **Package scope**: `@vercel/ai-gateway-vscode` vs `@vercel/ai-vscode` vs `@ai-sdk/vscode`?
2. **VS Code version support**: Should we support older VS Code versions without `LanguageModelDataPart.image()`?
3. **Bundling strategy**: Should the extension bundle the package or use it as peer dependency?
4. **Documentation**: Where should package docs live? Separate site or extension docs?

## Implementation Plan

### Phase 1: Package Extraction (Week 1-2)

- [ ] Create package structure
- [ ] Extract VSCodeStreamAdapter
- [ ] Extract HybridTokenEstimator
- [ ] Extract MessageConverter
- [ ] Write comprehensive tests

### Phase 2: Integration (Week 2-3)

- [ ] Update extension to use package
- [ ] Verify all tests pass
- [ ] Performance benchmarking
- [ ] Documentation

### Phase 3: Publication (Week 3-4)

- [ ] Publish to npm
- [ ] Update extension dependencies
- [ ] Release notes
- [ ] Announce to community
