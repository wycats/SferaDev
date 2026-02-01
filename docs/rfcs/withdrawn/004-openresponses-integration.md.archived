# RFC 004: OpenResponses API Integration

**Status:** Triage  
**Author:** Vercel AI Team  
**Created:** 2026-01-27  
**Updated:** 2026-01-29

## Summary

Integrate support for the OpenResponses API specification in the Vercel AI Gateway VS Code extension, enabling access to the unified, vendor-neutral API for AI model interactions while bridging the gaps between OpenResponses capabilities and VS Code's LanguageModel API.

## ⚠️ CRITICAL: API Format Disambiguation

**OpenResponses is its own wire protocol.** When working on this integration:

| ❌ OpenResponses is NOT                              | ✅ OpenResponses IS                 |
| ---------------------------------------------------- | ----------------------------------- |
| OpenAI Chat Completions API (`/v1/chat/completions`) | A distinct `/v1/responses` endpoint |
| Vercel AI SDK format (client library abstraction)    | A wire protocol specification       |
| "OpenAI-compatible" in any way                       | Vendor-neutral with its own schema  |

**Do NOT reference OpenAI or Vercel AI SDK documentation when implementing OpenResponses code.** The message formats, tool schemas, and streaming events are fundamentally different.

## Documentation References

| Resource                             | Location                                                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **Protocol Specification**           | [`packages/openresponses-client/docs/OPENRESPONSES-SPEC.md`](../../packages/openresponses-client/docs/OPENRESPONSES-SPEC.md) |
| **OpenAPI Schema (source of truth)** | [`packages/openresponses-client/openapi.json`](../../packages/openresponses-client/openapi.json)                             |
| **Client Package README**            | [`packages/openresponses-client/README.md`](../../packages/openresponses-client/README.md)                                   |
| **Client AGENTS.md**                 | [`packages/openresponses-client/AGENTS.md`](../../packages/openresponses-client/AGENTS.md)                                   |
| **VS Code Extension AGENTS.md**      | [`apps/vscode-ai-gateway/AGENTS.md`](../../apps/vscode-ai-gateway/AGENTS.md)                                                 |
| **Central Hub**                      | [`docs/OPENRESPONSES.md`](../OPENRESPONSES.md)                                                                               |
| **External: OpenResponses Website**  | https://www.openresponses.org                                                                                                |
| **External: OpenAPI JSON**           | https://www.openresponses.org/openapi/openapi.json                                                                           |

## Motivation

### What is OpenResponses?

[OpenResponses](https://openresponses.org/) is an open, vendor-neutral **wire protocol specification** for LLM APIs. It is **NOT** a library, SDK, or compatibility layer—it defines the actual HTTP request/response format.

**Key Protocol Characteristics:**

- **Endpoint:** `POST /v1/responses` (not `/v1/chat/completions`)
- **Input format:** Array of typed `items` (messages, function calls, function outputs)
- **Content types:** `input_text` for user/system, `output_text` for assistant
- **Tools:** Flat structure with `type`, `name`, `description`, `parameters` at top level
- **Streaming:** Server-Sent Events with typed event names like `response.output_text.delta`

**Additional characteristics:**

- **Community-governed** with formal technical charter
- **Items as atomic units** for agentic workflows (messages, tool calls, tool outputs, reasoning)
- **Semantic streaming events** (SSE) with typed event names
- **Multi-modal inputs** (text, image, file, video)
- **Reasoning metadata** including effort levels and encrypted reasoning content
- **Acceptance test suite** for compliance validation

### Why OpenResponses for VS Code?

1. **Vercel AI Gateway supports it**: Available at `https://ai-gateway.vercel.sh/v1/responses`
2. **Future-proof**: OpenResponses is gaining adoption (NVIDIA, OpenRouter, Hugging Face, LM Studio, Ollama)
3. **Rich features**: Reasoning, structured outputs, and tool calling are first-class
4. **Unified interface**: Single API works across all providers

### Current Ecosystem Status

| Platform           | OpenResponses Support |
| ------------------ | --------------------- |
| Vercel AI Gateway  | ✅ Full support       |
| VS Code Extensions | ❌ None found         |
| VS Code Core       | ❌ No native support  |
| AI SDK             | 🔄 In development     |

**Opportunity**: First VS Code extension with OpenResponses support.

## Detailed Design

### Gap Analysis: OpenResponses vs VS Code LanguageModel API

| Feature                | OpenResponses                              | VS Code LM API                       | Gap                       |
| ---------------------- | ------------------------------------------ | ------------------------------------ | ------------------------- |
| **Message Roles**      | `user`, `assistant`, `system`, `developer` | `User`, `Assistant` only             | No system/developer roles |
| **Multi-modal**        | text, image, file, video                   | Text, LanguageModelDataPart          | Limited to images         |
| **Tool Calling**       | Structured function tools with streaming   | LanguageModelToolCallPart            | ✅ Compatible             |
| **Tool Results**       | `function_call_output` items               | LanguageModelToolResultPart          | ✅ Compatible             |
| **Reasoning**          | `reasoning` with effort levels             | LanguageModelThinkingPart (unstable) | Partial, unstable API     |
| **Streaming**          | Typed SSE events                           | Progress<LanguageModelResponsePart>  | Need event mapping        |
| **Conversation State** | `previous_response_id`                     | None                                 | Must manage externally    |

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    VS Code Extension                         │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐    ┌─────────────────────────────────┐ │
│  │ LanguageModel   │    │ OpenResponses Adapter           │ │
│  │ ChatProvider    │───▶│ ┌─────────────────────────────┐ │ │
│  └─────────────────┘    │ │ Message Converter           │ │ │
│                         │ │ - Role mapping              │ │ │
│                         │ │ - System prompt injection   │ │ │
│                         │ │ - Multi-modal handling      │ │ │
│                         │ └─────────────────────────────┘ │ │
│                         │ ┌─────────────────────────────┐ │ │
│                         │ │ Stream Adapter              │ │ │
│                         │ │ - SSE event parsing         │ │ │
│                         │ │ - Tool call orchestration   │ │ │
│                         │ │ - Reasoning extraction      │ │ │
│                         │ └─────────────────────────────┘ │ │
│                         │ ┌─────────────────────────────┐ │ │
│                         │ │ Conversation State Manager  │ │ │
│                         │ │ - Response ID tracking      │ │ │
│                         │ │ - Item history              │ │ │
│                         │ └─────────────────────────────┘ │ │
│                         └─────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Vercel AI Gateway (OpenResponses)               │
│              https://ai-gateway.vercel.sh/v1/responses       │
└─────────────────────────────────────────────────────────────┘
```

### OpenResponses Client

```typescript
// src/openresponses/client.ts

export interface OpenResponsesConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
}

export interface ResponsesRequest {
  model: string;
  input: InputItem[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  tools?: FunctionTool[];
  tool_choice?: "auto" | "required" | "none";
  reasoning?: { effort: "low" | "medium" | "high" };
  previous_response_id?: string;
  providerOptions?: {
    gateway?: {
      models?: string[]; // Fallback models
    };
  };
}

export interface InputItem {
  type: "message" | "function_call" | "function_call_output";
  // Message fields
  role?: "user" | "assistant" | "system" | "developer";
  content?: string | ContentPart[];
  // Function call fields
  call_id?: string;
  name?: string;
  arguments?: string;
  // Function output fields
  output?: string;
}

export interface ContentPart {
  type: "input_text" | "input_image" | "input_file";
  text?: string;
  image_url?: string;
  file_url?: string;
}

export interface FunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: object;
  strict?: boolean;
}

export class OpenResponsesClient {
  private config: OpenResponsesConfig;

  constructor(config: OpenResponsesConfig) {
    this.config = config;
  }

  async createResponse(request: ResponsesRequest): Promise<Response> {
    return fetch(`${this.config.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(request),
    });
  }

  async *streamResponse(
    request: ResponsesRequest,
  ): AsyncGenerator<StreamEvent> {
    const response = await this.createResponse({ ...request, stream: true });

    if (!response.ok) {
      throw new OpenResponsesError(await response.json());
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          const eventType = line.slice(7);
          // Next line should be data
          continue;
        }
        if (line.startsWith("data: ")) {
          const data = JSON.parse(line.slice(6));
          yield data as StreamEvent;
        }
      }
    }
  }
}
```

### Message Conversion: VS Code → OpenResponses

```typescript
// src/openresponses/message-converter.ts

import type { LanguageModelChatMessage } from "vscode";
import type { InputItem } from "./client";

export interface ConversionContext {
  /** System prompt to inject (since VS Code doesn't support system messages) */
  systemPrompt?: string;
  /** Developer instructions (OpenResponses-specific) */
  developerInstructions?: string;
}

/**
 * Convert VS Code messages to OpenResponses input items.
 *
 * Key transformations:
 * 1. Inject system/developer messages at the start
 * 2. Map User/Assistant roles
 * 3. Convert LanguageModelDataPart to content parts
 * 4. Map tool calls/results to function items
 */
export function convertToOpenResponses(
  messages: readonly LanguageModelChatMessage[],
  context: ConversionContext = {},
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

  // Inject developer instructions if provided
  if (context.developerInstructions) {
    items.push({
      type: "message",
      role: "developer",
      content: context.developerInstructions,
    });
  }

  // Build tool name map for result lookups
  const toolNameMap = buildToolNameMap(messages);

  for (const msg of messages) {
    const converted = convertMessage(msg, toolNameMap);
    items.push(...converted);
  }

  return items;
}

function convertMessage(
  msg: LanguageModelChatMessage,
  toolNameMap: Record<string, string>,
): InputItem[] {
  const items: InputItem[] = [];
  const role =
    msg.role === LanguageModelChatMessageRole.User ? "user" : "assistant";

  const contentParts: ContentPart[] = [];

  for (const part of msg.content) {
    if (part instanceof LanguageModelTextPart) {
      contentParts.push({ type: "input_text", text: part.value });
    } else if (part instanceof LanguageModelDataPart) {
      if (part.mimeType.startsWith("image/")) {
        const base64 = Buffer.from(part.data).toString("base64");
        contentParts.push({
          type: "input_image",
          image_url: `data:${part.mimeType};base64,${base64}`,
        });
      }
    } else if (part instanceof LanguageModelToolCallPart) {
      // Flush content parts first
      if (contentParts.length > 0) {
        items.push({ type: "message", role, content: contentParts.splice(0) });
      }
      // Add function call item
      items.push({
        type: "function_call",
        call_id: part.callId,
        name: part.name,
        arguments: JSON.stringify(part.input),
      });
    } else if (part instanceof LanguageModelToolResultPart) {
      // Flush content parts first
      if (contentParts.length > 0) {
        items.push({ type: "message", role, content: contentParts.splice(0) });
      }
      // Add function output item
      const output = extractToolResultText(part);
      items.push({
        type: "function_call_output",
        call_id: part.callId,
        output,
      });
    }
  }

  // Flush remaining content parts
  if (contentParts.length > 0) {
    items.push({ type: "message", role, content: contentParts });
  }

  return items;
}
```

### Stream Event Mapping: OpenResponses → VS Code

```typescript
// src/openresponses/stream-adapter.ts

import type { LanguageModelResponsePart, Progress } from "vscode";

/**
 * OpenResponses SSE event types and their VS Code mappings:
 *
 * | OpenResponses Event                    | VS Code Part                    |
 * |----------------------------------------|---------------------------------|
 * | response.output_text.delta             | LanguageModelTextPart           |
 * | response.function_call_arguments.delta | (accumulate, emit on done)      |
 * | response.function_call.done            | LanguageModelToolCallPart       |
 * | response.reasoning.delta               | LanguageModelThinkingPart       |
 * | response.done                          | (finalize, extract usage)       |
 * | response.error                         | LanguageModelTextPart (error)   |
 */

export interface StreamEvent {
  type: string;
  // Text delta
  delta?: string;
  // Function call
  call_id?: string;
  name?: string;
  arguments?: string;
  // Done event
  response?: {
    id: string;
    usage?: { input_tokens: number; output_tokens: number };
  };
  // Error
  error?: { message: string; type: string };
}

export class OpenResponsesStreamAdapter {
  private functionCallAccumulator: Map<
    string,
    { name: string; arguments: string }
  > = new Map();
  private responseId: string | null = null;
  private usage: { inputTokens: number; outputTokens: number } | null = null;

  async processStream(
    stream: AsyncIterable<StreamEvent>,
    progress: Progress<LanguageModelResponsePart>,
  ): Promise<{ responseId: string | null; usage: typeof this.usage }> {
    for await (const event of stream) {
      this.handleEvent(event, progress);
    }
    return { responseId: this.responseId, usage: this.usage };
  }

  private handleEvent(
    event: StreamEvent,
    progress: Progress<LanguageModelResponsePart>,
  ): void {
    switch (event.type) {
      case "response.output_text.delta":
        if (event.delta) {
          progress.report(new LanguageModelTextPart(event.delta));
        }
        break;

      case "response.function_call_arguments.delta":
        // Accumulate function call arguments
        if (event.call_id && event.delta) {
          const existing = this.functionCallAccumulator.get(event.call_id);
          if (existing) {
            existing.arguments += event.delta;
          }
        }
        break;

      case "response.function_call.start":
        // Initialize function call accumulator
        if (event.call_id && event.name) {
          this.functionCallAccumulator.set(event.call_id, {
            name: event.name,
            arguments: "",
          });
        }
        break;

      case "response.function_call.done":
        // Emit complete tool call
        if (event.call_id) {
          const call = this.functionCallAccumulator.get(event.call_id);
          if (call) {
            try {
              const input = JSON.parse(call.arguments || "{}");
              progress.report(
                new LanguageModelToolCallPart(event.call_id, call.name, input),
              );
            } catch (e) {
              console.warn("Failed to parse function call arguments:", e);
            }
            this.functionCallAccumulator.delete(event.call_id);
          }
        }
        break;

      case "response.reasoning.delta":
        // Forward reasoning if unstable API is available
        this.handleReasoningDelta(event, progress);
        break;

      case "response.done":
        if (event.response) {
          this.responseId = event.response.id;
          if (event.response.usage) {
            this.usage = {
              inputTokens: event.response.usage.input_tokens,
              outputTokens: event.response.usage.output_tokens,
            };
          }
        }
        break;

      case "response.error":
        if (event.error) {
          progress.report(
            new LanguageModelTextPart(
              `\n\n**Error:** ${event.error.message}\n\n`,
            ),
          );
        }
        break;
    }
  }

  private handleReasoningDelta(
    event: StreamEvent,
    progress: Progress<LanguageModelResponsePart>,
  ): void {
    // Use unstable LanguageModelThinkingPart if available
    const vscodeAny = vscode as unknown as Record<string, unknown>;
    const ThinkingPart = vscodeAny.LanguageModelThinkingPart as
      | (new (text: string) => LanguageModelResponsePart)
      | undefined;

    if (ThinkingPart && event.delta) {
      progress.report(new ThinkingPart(event.delta));
    }
  }
}
```

### Conversation State Manager

```typescript
// src/openresponses/state-manager.ts

/**
 * Manages OpenResponses conversation state for multi-turn interactions.
 *
 * OpenResponses supports `previous_response_id` to continue conversations
 * without re-sending full history. This manager tracks response IDs and
 * provides efficient conversation continuation.
 */
export class ConversationStateManager {
  private responseHistory: Map<string, ResponseState> = new Map();
  private currentConversationId: string | null = null;

  interface ResponseState {
    responseId: string;
    messageCount: number;
    timestamp: number;
    usage: { inputTokens: number; outputTokens: number };
  }

  /**
   * Record a completed response for potential continuation.
   */
  recordResponse(
    conversationId: string,
    responseId: string,
    messageCount: number,
    usage: { inputTokens: number; outputTokens: number },
  ): void {
    this.responseHistory.set(conversationId, {
      responseId,
      messageCount,
      timestamp: Date.now(),
      usage,
    });
    this.currentConversationId = conversationId;
  }

  /**
   * Get the previous response ID for conversation continuation.
   * Returns null if the conversation has been modified (messages added/removed).
   */
  getPreviousResponseId(
    conversationId: string,
    currentMessageCount: number,
  ): string | null {
    const state = this.responseHistory.get(conversationId);
    if (!state) return null;

    // Only use previous_response_id if messages were appended (not edited)
    if (currentMessageCount > state.messageCount) {
      return state.responseId;
    }

    // Conversation was modified, need full replay
    return null;
  }

  /**
   * Clear state for a conversation (e.g., on reset).
   */
  clearConversation(conversationId: string): void {
    this.responseHistory.delete(conversationId);
  }

  /**
   * Prune old conversation states.
   */
  prune(maxAgeMs: number = 30 * 60 * 1000): void {
    const now = Date.now();
    for (const [id, state] of this.responseHistory) {
      if (now - state.timestamp > maxAgeMs) {
        this.responseHistory.delete(id);
      }
    }
  }
}
```

### Configuration

```json
{
  "contributes": {
    "configuration": {
      "properties": {
        "vercel.ai.openresponses.enabled": {
          "type": "boolean",
          "default": false,
          "description": "Use OpenResponses API instead of Chat Completions API (experimental)"
        },
        "vercel.ai.openresponses.reasoning.effort": {
          "type": "string",
          "enum": ["low", "medium", "high"],
          "default": "medium",
          "description": "Reasoning effort level for models that support it"
        },
        "vercel.ai.openresponses.conversationContinuation": {
          "type": "boolean",
          "default": true,
          "description": "Use previous_response_id for efficient conversation continuation"
        }
      }
    }
  }
}
```

## Drawbacks

1. **API stability**: OpenResponses is relatively new; spec may evolve
2. **Feature parity**: Not all AI SDK features may have OpenResponses equivalents
3. **Debugging complexity**: Additional abstraction layer
4. **VS Code API limitations**: System messages, reasoning still limited

## Alternatives

### Alternative 1: Wait for AI SDK OpenResponses Provider

Wait for official `@ai-sdk/openresponses` provider.

**Rejected because:** Timeline uncertain; we can provide value now.

### Alternative 2: OpenResponses-Only Mode

Replace Chat Completions entirely with OpenResponses.

**Rejected because:** Breaking change; should be opt-in.

### Alternative 3: Transparent Proxy

Automatically convert all requests to OpenResponses format.

**Considered:** Could be future default once stable.

## Unresolved Questions

1. **Fallback behavior**: What happens when OpenResponses endpoint is unavailable?
2. **Feature detection**: How to detect which OpenResponses features a model supports?
3. **Rate limiting**: Does OpenResponses have different rate limits?
4. **Caching**: Can we cache response IDs across VS Code sessions?

## Implementation Plan

### Phase 1: Core Client (Week 1)

- [ ] Implement OpenResponsesClient
- [ ] Implement message converter
- [ ] Implement stream adapter
- [ ] Basic tests

### Phase 2: Integration (Week 2)

- [ ] Add configuration options
- [ ] Integrate with existing provider
- [ ] Conversation state manager
- [ ] Error handling

### Phase 3: Advanced Features (Week 3)

- [ ] Reasoning support
- [ ] Multi-modal improvements
- [ ] Performance optimization
- [ ] Documentation

### Phase 4: Release (Week 4)

- [ ] Feature flag for opt-in
- [ ] Beta testing
- [ ] Feedback collection
- [ ] GA release
