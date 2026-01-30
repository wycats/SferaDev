# RFC 016: OpenResponses Architecture & Provider Refactoring

**Status:** Draft  
**Author:** GitHub Copilot (Claude Sonnet 4.5)  
**Created:** 2026-01-28  
**Updated:** 2026-01-28  
**Supersedes:** RFC 004 (OpenResponses Integration)

## Summary

Refactor the VS Code Language Model provider to use the OpenResponses API as the primary backend, replacing the current Vercel AI SDK Chat Completions approach. Simultaneously decompose the 1745-line monolithic `provider.ts` into focused, composable modules organized around the protocol boundary between VS Code and OpenResponses.

**Key Insight**: The current architecture uses the Vercel AI SDK's abstraction (`streamText`), which sits between us and the actual API. This abstraction loses critical metadata (token counts, finish reasons) that OpenResponses provides natively. By implementing OpenResponses directly, we get:

1. **Guaranteed token usage data** (`input_tokens`, `output_tokens` are required fields)
2. **Precise finish reasons** (not the generic "other" we're seeing)
3. **Richer metadata** (cached tokens, reasoning tokens, detailed breakdown)
4. **Better control** over the protocol mapping

## Motivation

### Problem 1: Missing Token Usage Data

Current state (via Vercel AI SDK):

```typescript
// What we get from response.usage
{
  "finishReason": "other",  // ❌ Not useful
  "usage": {
    "inputTokenDetails": {},   // ❌ Empty
    "outputTokenDetails": {}   // ❌ Empty
  }
}
```

OpenResponses native format:

```typescript
// What we'd get from OpenResponses directly
{
  "usage": {
    "input_tokens": 1234,          // ✅ Required field
    "output_tokens": 567,          // ✅ Required field
    "total_tokens": 1801,          // ✅ Required field
    "input_tokens_details": {
      "cached_tokens": 800         // ✅ Cache visibility
    },
    "output_tokens_details": {
      "reasoning_tokens": 123      // ✅ Reasoning breakdown
    }
  }
}
```

**Impact**: Without accurate token counts, VS Code's conversation summarization never triggers, causing "Input is too long" errors.

### Problem 2: Provider.ts is Unwieldy

The current `provider.ts` is 1745 lines doing too many things:

- HTTP client setup
- Message conversion (VS Code ↔ Vercel AI SDK)
- Stream chunk handling (15+ chunk types)
- Tool call buffering and assembly
- Token estimation and caching
- Usage tracking and status bar updates
- Error handling and logging
- Model enrichment coordination
- Context management detection

This violates single responsibility and makes the code hard to:

- **Test**: Integration tests require mocking the entire world
- **Debug**: Hard to trace which layer is causing issues
- **Extend**: Adding features touches the monolith
- **Understand**: New contributors face a steep learning curve

### Problem 3: Layering Confusion

The current architecture has confusing boundaries:

```
VS Code API → provider.ts → Vercel AI SDK → @ai-sdk/gateway → OpenResponses
                   ↓
            (everything happens here)
```

**The insight**: We're one layer too high. The Vercel AI SDK's `streamText()` is designed for application developers who want a unified interface. But we ARE a provider - we need the raw protocol.

## Detailed Design

### Architecture: Protocol Boundary as Organizing Principle

The new architecture is organized around the **VS Code ↔ OpenResponses protocol boundary**:

```
┌─────────────────────────────────────────────────────────────────┐
│                    VS Code Extension Host                        │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  VS Code LanguageModelChatProvider Interface               │ │
│  └────────────────────────────────────────────────────────────┘ │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│             src/provider/index.ts (Facade)                       │
│  - Implements LanguageModelChatProvider                          │
│  - Orchestrates the pipeline                                     │
│  - Thin coordination layer (~200 lines)                          │
└──────────────────────────────┬───────────────────────────────────┘
                               │
            ┌──────────────────┼──────────────────┐
            ▼                  ▼                  ▼
   ┌─────────────────┐ ┌─────────────┐ ┌──────────────────┐
   │ Message         │ │   Stream    │ │  Usage           │
   │ Translation     │ │   Adapter   │ │  Tracker         │
   │                 │ │             │ │                  │
   │ VS Code msgs    │ │ SSE events  │ │ Token counting   │
   │ → OpenResponses │ │ → VS Code   │ │ Status bar       │
   │ items           │ │ parts       │ │ Cache updates    │
   └─────────────────┘ └─────────────┘ └──────────────────┘
            │                  ▲                  ▲
            │                  │                  │
            └──────────────────┼──────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│              src/openresponses/client.ts                         │
│  - Direct HTTP client (no SDK wrapper)                           │
│  - SSE stream parsing                                            │
│  - Type-safe event handling                                      │
│  - Error classification                                          │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│           Vercel AI Gateway /v1/responses endpoint               │
│           (OpenResponses-compliant API)                          │
└─────────────────────────────────────────────────────────────────┘
```

### Module Structure

```
src/
├── provider/
│   ├── index.ts              # Main facade, ~200 lines
│   ├── message-translator.ts # VS Code → OpenResponses
│   ├── stream-adapter.ts     # OpenResponses SSE → VS Code parts
│   ├── usage-tracker.ts      # Token counting & status bar
│   └── tool-buffer.ts        # Tool call accumulation
│
├── openresponses/
│   ├── client.ts             # HTTP client, SSE parsing
│   ├── types.ts              # OpenResponses TypeScript types
│   └── errors.ts             # Error classification
│
├── tokens/
│   ├── cache.ts              # Token count caching (existing)
│   ├── counter.ts            # Token estimation (existing)
│   └── estimator.ts          # Cache-aware estimation (existing)
│
├── models/
│   ├── client.ts             # Model discovery (existing)
│   ├── enrichment.ts         # Capability detection (existing)
│   └── identity.ts           # Model ID parsing (existing)
│
└── config.ts                 # Configuration (existing)
```

### Core Types: OpenResponses Protocol

```typescript
// src/openresponses/types.ts

/**
 * OpenResponses request payload
 * Spec: https://openresponses.org/
 */
export interface CreateResponseRequest {
  /** Model identifier (e.g., "anthropic:claude-sonnet-4") */
  model: string;

  /** Input items (messages, tool calls, tool results) */
  input: InputItem[];

  /** Enable Server-Sent Events streaming */
  stream?: boolean;

  /** Temperature (0-2) */
  temperature?: number;

  /** Nucleus sampling threshold */
  top_p?: number;

  /** Maximum output tokens */
  max_output_tokens?: number;

  /** Available tools */
  tools?: FunctionTool[];

  /** Tool selection strategy */
  tool_choice?: "auto" | "required" | "none";

  /** Reasoning configuration (o-series models) */
  reasoning?: {
    effort?: "low" | "medium" | "high" | "xhigh";
    summary?: "concise" | "detailed" | "auto";
  };

  /** Continue from previous response (efficient multi-turn) */
  previous_response_id?: string;
}

/**
 * Input item types
 */
export type InputItem =
  | MessageItem
  | FunctionCallItem
  | FunctionCallOutputItem
  | ReasoningItem;

export interface MessageItem {
  type: "message";
  id?: string;
  role: "user" | "assistant" | "system" | "developer";
  content: string | ContentPart[];
}

export type ContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: "low" | "high" | "auto" }
  | { type: "input_file"; filename?: string; file_url: string }
  | { type: "input_video"; video_url: string };

export interface FunctionCallItem {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
  arguments: string; // JSON string
  status?: "in_progress" | "completed" | "incomplete";
}

export interface FunctionCallOutputItem {
  type: "function_call_output";
  id?: string;
  call_id: string;
  output: string; // JSON string or text
  status?: "completed";
}

export interface FunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>; // JSON Schema
  strict?: boolean;
}

/**
 * Response resource (non-streaming)
 */
export interface ResponseResource {
  id: string;
  object: "response";
  created_at: number;
  completed_at: number | null;
  status: "in_progress" | "completed" | "incomplete" | "failed";
  model: string;

  /** Generated items (messages, function calls, reasoning) */
  output: OutputItem[];

  /** Token usage - REQUIRED FIELDS */
  usage: Usage | null;

  /** Finish details */
  incomplete_details?: {
    reason: string;
  };
  error?: {
    code: string;
    message: string;
  };
}

export type OutputItem =
  | OutputMessageItem
  | OutputFunctionCallItem
  | OutputReasoningItem;

export interface OutputMessageItem {
  type: "message";
  id: string;
  role: "assistant";
  status: "in_progress" | "completed" | "incomplete";
  content: OutputContentPart[];
}

export type OutputContentPart =
  | { type: "output_text"; text: string; annotations: Annotation[] }
  | { type: "refusal"; refusal: string };

export interface OutputFunctionCallItem {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: "in_progress" | "completed" | "incomplete";
}

export interface OutputReasoningItem {
  type: "reasoning";
  id: string;
  summary: { type: "summary_text"; text: string }[];
  content?: { type: "reasoning_text"; text: string }[];
  encrypted_content?: string;
}

/**
 * Usage data - ALL FIELDS REQUIRED
 * This is the key advantage over AI SDK's optional usage
 */
export interface Usage {
  /** Input tokens consumed (required) */
  input_tokens: number;

  /** Output tokens generated (required) */
  output_tokens: number;

  /** Total tokens (required) */
  total_tokens: number;

  /** Breakdown of input tokens */
  input_tokens_details: {
    /** Tokens served from cache */
    cached_tokens: number;
  };

  /** Breakdown of output tokens */
  output_tokens_details: {
    /** Tokens attributed to reasoning */
    reasoning_tokens: number;
  };
}

/**
 * Streaming events
 */
export type StreamEvent =
  | ResponseCreatedEvent
  | ResponseInProgressEvent
  | ResponseCompletedEvent
  | ResponseFailedEvent
  | OutputItemAddedEvent
  | OutputTextDeltaEvent
  | FunctionCallArgumentsDeltaEvent
  | FunctionCallDoneEvent
  | ReasoningDeltaEvent
  | ErrorEvent;

export interface ResponseCompletedEvent {
  type: "response.completed";
  sequence_number: number;
  response: ResponseResource; // Includes full usage!
}

export interface OutputTextDeltaEvent {
  type: "response.output_text.delta";
  sequence_number: number;
  item_id: string;
  output_index: number;
  content_index: number;
  delta: string;
}

export interface FunctionCallArgumentsDeltaEvent {
  type: "response.function_call_arguments.delta";
  sequence_number: number;
  item_id: string;
  output_index: number;
  delta: string;
}

export interface FunctionCallDoneEvent {
  type: "response.output_item.done";
  sequence_number: number;
  output_index: number;
  item: OutputFunctionCallItem;
}

export interface ErrorEvent {
  type: "error";
  sequence_number: number;
  error: {
    type: string;
    code: string | null;
    message: string;
    param: string | null;
  };
}
```

### Message Translator: VS Code → OpenResponses

```typescript
// src/provider/message-translator.ts

import type {
  LanguageModelChatRequestMessage,
  LanguageModelTextPart,
  LanguageModelDataPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
} from "vscode";
import type { InputItem, ContentPart } from "../openresponses/types";

export interface TranslationContext {
  /** System prompt to inject (VS Code has no system role) */
  systemPrompt?: string;
}

/**
 * Translate VS Code messages to OpenResponses input items.
 *
 * Key transformations:
 * 1. Inject system message at start (VS Code limitation)
 * 2. Map User/Assistant roles (1:1)
 * 3. Split messages at tool call boundaries (OpenResponses requires separate items)
 * 4. Convert LanguageModelDataPart to typed content parts
 * 5. Map tool calls/results to function_call/function_call_output items
 */
export function translateMessages(
  messages: readonly LanguageModelChatRequestMessage[],
  context: TranslationContext = {},
): InputItem[] {
  const items: InputItem[] = [];

  // Inject system prompt if provided
  if (context.systemPrompt) {
    items.push({
      type: "message",
      role: "system",
      content: context.systemPrompt,
    });
  }

  for (const msg of messages) {
    items.push(...translateMessage(msg));
  }

  return items;
}

function translateMessage(msg: LanguageModelChatRequestMessage): InputItem[] {
  const items: InputItem[] = [];
  const role =
    msg.role === LanguageModelChatMessageRole.User ? "user" : "assistant";

  let currentContent: ContentPart[] = [];

  for (const part of msg.content) {
    if (part instanceof LanguageModelTextPart) {
      currentContent.push({
        type: "input_text",
        text: part.value,
      });
    } else if (part instanceof LanguageModelDataPart) {
      const contentPart = translateDataPart(part);
      if (contentPart) {
        currentContent.push(contentPart);
      }
    } else if (part instanceof LanguageModelToolCallPart) {
      // Flush accumulated content
      if (currentContent.length > 0) {
        items.push({
          type: "message",
          role,
          content: currentContent,
        });
        currentContent = [];
      }

      // Add function call as separate item
      items.push({
        type: "function_call",
        call_id: part.callId,
        name: part.name,
        arguments: JSON.stringify(part.input),
      });
    } else if (part instanceof LanguageModelToolResultPart) {
      // Flush accumulated content
      if (currentContent.length > 0) {
        items.push({
          type: "message",
          role,
          content: currentContent,
        });
        currentContent = [];
      }

      // Add function output as separate item
      items.push({
        type: "function_call_output",
        call_id: part.callId,
        output: extractToolOutput(part),
      });
    }
  }

  // Flush remaining content
  if (currentContent.length > 0) {
    items.push({
      type: "message",
      role,
      content: currentContent,
    });
  }

  return items;
}

function translateDataPart(part: LanguageModelDataPart): ContentPart | null {
  if (part.mimeType.startsWith("image/")) {
    const base64 = Buffer.from(part.data).toString("base64");
    return {
      type: "input_image",
      image_url: `data:${part.mimeType};base64,${base64}`,
      detail: "auto",
    };
  }

  // Other mime types not yet supported
  return null;
}

function extractToolOutput(part: LanguageModelToolResultPart): string {
  // LanguageModelToolResultPart.content is LanguageModelTextPart | LanguageModelDataPart
  // For now, extract text; future: support structured outputs
  for (const content of part.content) {
    if (content instanceof LanguageModelTextPart) {
      return content.value;
    }
  }
  return "{}"; // Empty result
}
```

### Stream Adapter: OpenResponses SSE → VS Code Parts

```typescript
// src/provider/stream-adapter.ts

import {
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  type Progress,
  type LanguageModelResponsePart,
} from "vscode";
import type { StreamEvent, Usage } from "../openresponses/types";
import { logger } from "../logger";

export interface StreamResult {
  /** Response ID for conversation continuation */
  responseId: string | null;

  /** Token usage (guaranteed by OpenResponses) */
  usage: Usage | null;
}

/**
 * Adapt OpenResponses SSE events to VS Code LanguageModelResponseParts.
 *
 * Event mapping:
 * - response.output_text.delta → LanguageModelTextPart (delta)
 * - response.function_call_arguments.delta → (buffer, emit on done)
 * - response.output_item.done (function_call) → LanguageModelToolCallPart
 * - response.reasoning.delta → LanguageModelThinkingPart (if available)
 * - response.completed → extract usage & responseId
 * - error → LanguageModelTextPart (formatted error)
 */
export class OpenResponsesStreamAdapter {
  private toolCallBuffer = new Map<string, { name: string; args: string }>();
  private result: StreamResult = { responseId: null, usage: null };

  async processStream(
    events: AsyncIterable<StreamEvent>,
    progress: Progress<LanguageModelResponsePart>,
  ): Promise<StreamResult> {
    for await (const event of events) {
      this.handleEvent(event, progress);
    }

    return this.result;
  }

  private handleEvent(
    event: StreamEvent,
    progress: Progress<LanguageModelResponsePart>,
  ): void {
    logger.trace(`[OpenResponses] Event: ${event.type}`);

    switch (event.type) {
      case "response.output_text.delta":
        if (event.delta) {
          progress.report(new LanguageModelTextPart(event.delta));
        }
        break;

      case "response.function_call_arguments.delta":
        this.bufferToolArguments(event);
        break;

      case "response.output_item.done":
        if (event.item?.type === "function_call") {
          this.emitToolCall(event.item, progress);
        }
        break;

      case "response.reasoning.delta":
        this.emitReasoningIfSupported(event, progress);
        break;

      case "response.completed":
        this.extractFinalMetadata(event);
        break;

      case "error":
        this.emitError(event, progress);
        break;

      default:
        logger.debug(`[OpenResponses] Unhandled event: ${event.type}`);
    }
  }

  private bufferToolArguments(event: FunctionCallArgumentsDeltaEvent): void {
    if (!event.item_id || !event.delta) return;

    const buffered = this.toolCallBuffer.get(event.item_id);
    if (buffered) {
      buffered.args += event.delta;
    } else {
      // First delta - we don't have the name yet, will get it in done event
      this.toolCallBuffer.set(event.item_id, { name: "", args: event.delta });
    }
  }

  private emitToolCall(
    item: OutputFunctionCallItem,
    progress: Progress<LanguageModelResponsePart>,
  ): void {
    try {
      const input = JSON.parse(item.arguments);
      progress.report(
        new LanguageModelToolCallPart(item.call_id, item.name, input),
      );

      // Clear buffer
      this.toolCallBuffer.delete(item.id);
    } catch (e) {
      logger.error(`Failed to parse tool call arguments for ${item.name}:`, e);
    }
  }

  private emitReasoningIfSupported(
    event: ReasoningDeltaEvent,
    progress: Progress<LanguageModelResponsePart>,
  ): void {
    // Check for unstable LanguageModelThinkingPart
    const vscodeAny = vscode as any;
    const ThinkingPart = vscodeAny.LanguageModelThinkingPart;

    if (ThinkingPart && event.delta) {
      progress.report(new ThinkingPart(event.delta));
    } else {
      logger.trace(
        "[OpenResponses] Reasoning content received but ThinkingPart not available",
      );
    }
  }

  private extractFinalMetadata(event: ResponseCompletedEvent): void {
    this.result.responseId = event.response.id;
    this.result.usage = event.response.usage;

    logger.debug(
      `[OpenResponses] Response completed`,
      JSON.stringify({
        id: event.response.id,
        usage: event.response.usage,
        status: event.response.status,
      }),
    );
  }

  private emitError(
    event: ErrorEvent,
    progress: Progress<LanguageModelResponsePart>,
  ): void {
    const message = event.error.message || "Unknown error";
    logger.error(`[OpenResponses] Error: ${message}`, event.error);

    progress.report(new LanguageModelTextPart(`\n\n**Error**: ${message}\n\n`));
  }
}
```

### OpenResponses HTTP Client

```typescript
// src/openresponses/client.ts

import type {
  CreateResponseRequest,
  ResponseResource,
  StreamEvent,
} from "./types";
import { OpenResponsesError } from "./errors";

export interface ClientConfig {
  baseUrl: string;
  apiKey: string;
}

/**
 * Direct HTTP client for OpenResponses API.
 * No SDK abstractions - we own the protocol.
 */
export class OpenResponsesClient {
  constructor(private config: ClientConfig) {}

  /**
   * Create a streaming response.
   * Returns an async generator of SSE events.
   */
  async *stream(
    request: CreateResponseRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const response = await this.fetch(
      {
        ...request,
        stream: true,
      },
      signal,
    );

    if (!response.ok) {
      throw await OpenResponsesError.fromResponse(response);
    }

    if (!response.body) {
      throw new Error("No response body");
    }

    yield* this.parseSSE(response.body);
  }

  /**
   * Parse Server-Sent Events stream
   */
  private async *parseSSE(
    body: ReadableStream<Uint8Array>,
  ): AsyncGenerator<StreamEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Split by double newline (event boundary)
        const events = buffer.split("\n\n");
        buffer = events.pop() || ""; // Keep incomplete event

        for (const eventText of events) {
          const event = this.parseEvent(eventText);
          if (event) {
            yield event;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Parse a single SSE event
   */
  private parseEvent(text: string): StreamEvent | null {
    const lines = text.split("\n");
    let eventType: string | null = null;
    let data: string | null = null;

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7);
      } else if (line.startsWith("data: ")) {
        data = line.slice(6);
      }
    }

    if (!data) return null;

    try {
      const parsed = JSON.parse(data);
      return parsed as StreamEvent;
    } catch (e) {
      console.error("Failed to parse SSE event:", e);
      return null;
    }
  }

  private async fetch(
    request: CreateResponseRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    return fetch(`${this.config.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(request),
      signal,
    });
  }
}
```

### Usage Tracker

```typescript
// src/provider/usage-tracker.ts

import type { Usage } from "../openresponses/types";
import type { TokenStatusBar } from "../status-bar";
import { logger } from "../logger";

/**
 * Track token usage and update status bar.
 *
 * OpenResponses provides guaranteed usage data, so this is much simpler
 * than the current implementation that has to handle missing data.
 */
export class UsageTracker {
  constructor(private statusBar: TokenStatusBar | null) {}

  /**
   * Start tracking a new request
   */
  startRequest(
    agentId: string,
    estimatedInputTokens: number,
    maxInputTokens: number,
    modelId: string,
  ): void {
    this.statusBar?.startAgent(
      agentId,
      estimatedInputTokens,
      maxInputTokens,
      modelId,
    );
  }

  /**
   * Complete tracking with actual usage data from OpenResponses
   */
  completeRequest(agentId: string, usage: Usage, modelId: string): void {
    logger.debug(
      `[Usage] Completing agent ${agentId}`,
      JSON.stringify({
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cachedTokens: usage.input_tokens_details.cached_tokens,
        reasoningTokens: usage.output_tokens_details.reasoning_tokens,
      }),
    );

    this.statusBar?.completeAgent(agentId, {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      maxInputTokens: 0, // Not needed for completion
      modelId,
    });
  }
}
```

### Provider Facade

```typescript
// src/provider/index.ts

import type {
  LanguageModelChatProvider,
  LanguageModelChatInformation,
  LanguageModelChatRequestMessage,
  ProvideLanguageModelChatResponseOptions,
  Progress,
  LanguageModelResponsePart,
  CancellationToken,
} from "vscode";
import { OpenResponsesClient } from "../openresponses/client";
import { translateMessages } from "./message-translator";
import { OpenResponsesStreamAdapter } from "./stream-adapter";
import { UsageTracker } from "./usage-tracker";
import type { EnrichedModelData } from "../models/enrichment";

/**
 * Lightweight facade that orchestrates the pipeline:
 *
 * 1. Translate: VS Code messages → OpenResponses items
 * 2. Request: Call OpenResponses API
 * 3. Adapt: SSE events → VS Code parts
 * 4. Track: Update usage & status bar
 */
export class VercelAIChatModelProvider implements LanguageModelChatProvider {
  private client: OpenResponsesClient;
  private usageTracker: UsageTracker;

  constructor(
    config: ProviderConfig,
    // ... other dependencies
  ) {
    this.client = new OpenResponsesClient({
      baseUrl: config.gatewayBaseUrl,
      apiKey: "", // Set per-request
    });
    this.usageTracker = new UsageTracker(statusBar);
  }

  async provideLanguageModelChatResponse(
    model: EnrichedModelData,
    messages: readonly LanguageModelChatRequestMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    progress: Progress<LanguageModelResponsePart>,
    token: CancellationToken,
  ): Promise<void> {
    const agentId = generateAgentId();

    // 1. Translate messages
    const items = translateMessages(messages, {
      systemPrompt: options.modelOptions?.systemPrompt,
    });

    // 2. Prepare request
    const request: CreateResponseRequest = {
      model: model.id,
      input: items,
      stream: true,
      temperature: options.modelOptions?.temperature ?? 0.7,
      max_output_tokens: options.modelOptions?.maxOutputTokens ?? 4096,
      tools: translateTools(options.tools || []),
      tool_choice: translateToolMode(options.toolMode),
    };

    // 3. Start usage tracking
    const estimatedTokens = await this.estimateTokens(messages, model);
    this.usageTracker.startRequest(
      agentId,
      estimatedTokens,
      model.maxInputTokens,
      model.id,
    );

    // 4. Stream response
    const apiKey = await this.getApiKey();
    this.client.config.apiKey = apiKey;

    const adapter = new OpenResponsesStreamAdapter();
    const events = this.client.stream(request, token);
    const result = await adapter.processStream(events, progress);

    // 5. Complete usage tracking
    if (result.usage) {
      this.usageTracker.completeRequest(agentId, result.usage, model.id);
    }
  }

  // ... other methods (model listing, token estimation, etc.)
}
```

## Migration Plan

### Phase 1: Parallel Implementation (Week 1-2)

**Goal**: Build OpenResponses modules alongside existing code

- [ ] Create `src/openresponses/` with types, client, errors
- [ ] Create `src/provider/` with translator, stream-adapter, usage-tracker
- [ ] Write comprehensive unit tests for each module
- [ ] Feature flag: `vercel.ai.useOpenResponses` (default: false)

**Deliverable**: New code paths tested but not activated

### Phase 2: Integration Testing (Week 3)

**Goal**: Validate the new implementation works end-to-end

- [ ] Integration tests comparing old vs new behavior
- [ ] Manual testing with various models (Claude, GPT, o-series)
- [ ] Token usage verification (the key benefit!)
- [ ] Performance benchmarking

**Deliverable**: Confidence the new implementation works

### Phase 3: Staged Rollout (Week 4)

**Goal**: Ship to users incrementally

- [ ] Beta: Enable for maintainers/early adopters
- [ ] Collect telemetry on token usage accuracy
- [ ] Fix any edge cases discovered
- [ ] Flip flag to default: true

**Deliverable**: Production-ready with usage data

### Phase 4: Cleanup (Week 5)

**Goal**: Remove old code

- [ ] Delete Vercel AI SDK dependency
- [ ] Delete old provider.ts monolith
- [ ] Update documentation
- [ ] Remove feature flag

**Deliverable**: Clean, maintainable codebase

## Benefits

### 1. Guaranteed Token Usage

OpenResponses REQUIRES `input_tokens`, `output_tokens`, and `total_tokens`. No more:

- `outputTokens: 0` on every completion
- `finishReason: "other"` mystery
- Empty usage data causing summarization failures

### 2. Better Debugging

Clear module boundaries make issues easier to isolate:

- Network problem? → `openresponses/client.ts`
- Wrong message format? → `provider/message-translator.ts`
- Missing text? → `provider/stream-adapter.ts`
- Token count wrong? → `provider/usage-tracker.ts`

### 3. Easier Testing

Small, focused modules are easier to test:

```typescript
// Test message translation in isolation
const items = translateMessages(vscodeMessages);
expect(items[0]).toEqual({ type: "message", role: "system", ... });

// Test stream adaptation in isolation
const adapter = new OpenResponsesStreamAdapter();
const events = mockSSEStream([...]);
await adapter.processStream(events, mockProgress);
```

### 4. Future-Proof

Direct protocol implementation means we can:

- Add new OpenResponses features quickly
- Optimize based on actual API behavior
- Contribute improvements to OpenResponses spec
- Support multiple backends (not just Vercel Gateway)

## Risks & Mitigations

### Risk 1: OpenResponses Spec Changes

**Mitigation**:

- Version the client (`/v1/responses`)
- Types match OpenAPI schema exactly
- Update when spec stabilizes

### Risk 2: Feature Regression

**Mitigation**:

- Comprehensive test coverage before migration
- Feature flag for gradual rollout
- Keep old code during transition

### Risk 3: Performance

**Mitigation**:

- Benchmark both implementations
- Profile critical paths
- Optimize SSE parsing if needed

## Alternatives Considered

### Alternative 1: Fix Vercel AI SDK

Contribute fixes to `ai` package to preserve usage data.

**Rejected**:

- SDK is designed for app developers, not providers
- Adds indirection we don't need
- Slower iteration cycle

### Alternative 2: Incremental Refactoring

Break up provider.ts without changing protocols.

**Rejected**:

- Doesn't solve the token usage problem (the critical issue)
- Refactoring a bad abstraction still leaves a bad abstraction

### Alternative 3: Wait for Official SDK

Wait for `@ai-sdk/openresponses`.

**Rejected**:

- Timeline unknown
- We need token usage data NOW
- We'd still need similar refactoring

## Success Metrics

1. **Token Usage Accuracy**: 100% of completions report accurate input/output tokens
2. **Code Health**: Provider code <1000 lines, average module <200 lines
3. **Test Coverage**: >90% coverage on new modules
4. **Performance**: <5% latency increase vs current implementation
5. **Reliability**: Zero "Input is too long" errors due to summarization failure

## Open Questions

1. **`previous_response_id` optimization**: OpenResponses allows sending only new messages by referencing the previous response ID. This could reduce input tokens significantly for long conversations.

   **Current analysis** (may be incomplete): VS Code's `LanguageModelChatRequestMessage` and `ProvideLanguageModelChatResponseOptions` don't include any conversation/session/request identifiers. Each call appears stateless - we receive the full message array with no indication of whether it's a continuation or a fresh conversation.

   We _could_ attempt to infer continuations by hashing message history, but this is fragile (any edit breaks the hash) and adds complexity.

   **v1 Decision**: Skip this optimization. Focus on accurate token counts first.

   **Revisit when**:
   - We have real-world usage data showing this would meaningfully reduce costs
   - VS Code adds conversation/session IDs to their API
   - We discover a robust pattern for detecting continuations

## Scope Decisions

These questions from the original draft have been resolved:

| Question                                          | Decision                                                                                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Support both Vercel AI Gateway and direct OpenAI? | **No**. We only support Vercel AI Gateway via OpenResponses.                                                                                    |
| Handle models that don't support OpenResponses?   | **N/A**. We only target Vercel AI Gateway.                                                                                                      |
| Expose OpenResponses features in VS Code UI?      | **Yes, if reasonable**. Start with accurate token counts, then expose additional features (like reasoning effort) where the VS Code API allows. |

## References

- [OpenResponses Specification](https://openresponses.org/)
- [OpenResponses OpenAPI Schema](https://github.com/openresponses/openresponses)
- [VS Code Language Model API](https://code.visualstudio.com/api/references/vscode-api#lm)
- [RFC 004: OpenResponses Integration](./stage-0/004-openresponses-integration.md) (superseded)
