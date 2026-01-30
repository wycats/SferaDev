# RFC 003: Streaming Adapter Extraction

**Status:** Implemented  
**Author:** Vercel AI Team  
**Created:** 2026-01-27  
**Updated:** 2026-01-27

## Summary

Extract the VS Code streaming adapter and chunk handling logic into a reusable package module, including the `VSCodeStreamAdapter`, chunk handlers, and mapping from AI SDK stream events to `LanguageModelResponsePart`.

## Motivation

The existing extension embeds complex stream handling in `apps/vscode-ai-gateway/src/provider.ts`. This logic should be reusable across VS Code integrations while maintaining consistent behavior for tool calls, reasoning parts, and data chunk adaptation.

## Detailed Design

### Adapter Module Structure

```
@vercel/ai-gateway-vscode/
└── src/
    └── adapter/
        ├── stream-adapter.ts       # VSCodeStreamAdapter class
        ├── chunk-handlers.ts       # Individual chunk type handlers
        └── types.ts                # Adapter types
```

### VSCodeStreamAdapter

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

  async processStream(
    stream: AsyncIterable<TextStreamPart<ToolSet>>,
    progress: Progress<LanguageModelResponsePart>,
  ): Promise<StreamUsage> {
    for await (const chunk of stream) {
      this.handleChunk(chunk, progress);
    }
    return this.usage;
  }

  async *adaptStream(
    stream: AsyncIterable<TextStreamPart<ToolSet>>,
  ): AsyncGenerator<LanguageModelResponsePart> {
    for await (const chunk of stream) {
      const part = this.mapChunk(chunk);
      if (part) yield part;
    }
  }

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

  // ... individual handlers (see chunk-handlers.ts)
}
```

### Chunk Handlers & Response Part Mapping

The adapter converts AI SDK `fullStream` chunks to VS Code `LanguageModelResponsePart` instances:

- `text-delta` → `LanguageModelTextPart`
- `reasoning-delta` → `LanguageModelThinkingPart` (when available; otherwise ignored)
- `tool-call` → `LanguageModelToolCallPart`
- `file` → `LanguageModelDataPart` (image/json/text based on MIME)
- `error` → `LanguageModelTextPart` (prefixed error content)
- `finish` / `finish-step` → usage bookkeeping only
- unknown → `onUnknownChunk` callback

Detailed mapping tables and edge-case handling are tracked in the reference document [ref-stream-mapping](./ref-stream-mapping.md).

### Usage in Extension

```typescript
import { VSCodeStreamAdapter } from "@vercel/ai-gateway-vscode";

export class VercelAIChatModelProvider implements LanguageModelChatProvider {
  private streamAdapter = new VSCodeStreamAdapter({ enableReasoning: true });

  async provideLanguageModelChatResponse(
    model: LanguageModelChatInformation,
    chatMessages: readonly LanguageModelChatMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    progress: Progress<LanguageModelResponsePart>,
    token: CancellationToken,
  ): Promise<void> {
    const response = streamText({ model: gateway(model.id), messages: [] });
    await this.streamAdapter.processStream(response.fullStream, progress);
  }
}
```

## Implementation Notes

Implemented in apps/vscode-ai-gateway/src/provider.ts, where the streaming response handling maps AI SDK `fullStream` chunks to VS Code `LanguageModelResponsePart` instances and applies the updated chunk handling logic.

## Drawbacks

1. **Additional dependency**: Extension now depends on a separate adapter module.
2. **Version coordination**: Adapter and extension must stay compatible.

## Alternatives

### Alternative 1: Keep Logic in Extension

**Rejected because:** Adapter logic is valuable for reuse in other VS Code integrations.

## Unresolved Questions

1. **VS Code version support**: How to handle missing `LanguageModelThinkingPart` in older versions?
2. **Chunk schema drift**: How aggressively should the adapter validate unexpected chunk shapes?

## Implementation Plan

1. Extract adapter and chunk handlers into `@vercel/ai-gateway-vscode`.
2. Add tests for chunk mapping and usage handling.
3. Update the extension to use the adapter module.
