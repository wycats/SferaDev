---
title: SSE-to-VS Code State Machine Mapping
stage: 0
feature: Unknown
exo:
  tool: exo rfc create
  protocol: 1
---

# RFC 00022: SSE-to-VS Code State Machine Mapping

**Stage:** 0 (Draft)  
**Created:** 2026-01-30  
**Authors:** AI Gateway Team

## Summary

This RFC documents the precise mapping between OpenResponses SSE streaming events and VS Code Language Model API calls. It defines the state machine that the stream adapter must implement to correctly translate the rich SSE event stream into VS Code's simpler response model.

## Motivation

The OpenResponses SSE protocol provides fine-grained streaming events for tool calls, text, reasoning, and other content types. VS Code's Language Model API has a simpler model with atomic parts. Incorrect mapping causes:

1. **Duplicate tool calls** - emitting the same tool call multiple times
2. **Lost context** - dropping events that should contribute to output
3. **Ordering issues** - interleaved events processed incorrectly
4. **Resource waste** - doubled context size from duplicate tool results

## VS Code Language Model API Contract

### Response Parts

VS Code defines these response part types that providers can emit via `progress.report()`:

| Part Type                   | Purpose                | Atomicity                            |
| --------------------------- | ---------------------- | ------------------------------------ |
| `LanguageModelTextPart`     | Text content           | Incremental (many chunks OK)         |
| `LanguageModelToolCallPart` | Tool call request      | **Atomic** (exactly once per callId) |
| `LanguageModelDataPart`     | Binary/structured data | Atomic (not rendered in chat UI)     |

### Key Constraints

1. **Tool calls are atomic**: `LanguageModelToolCallPart` must be emitted exactly once per `callId`, with complete `name` and `input` (arguments).

2. **No incremental tool calls**: There is no way to signal "tool call starting" or "arguments streaming". The tool call appears all at once.

3. **Ordered stream**: Parts are delivered to consumers in the order `progress.report()` is called.

4. **No progress indicators**: VS Code does not define dedicated parts for "thinking", "reasoning", or "progress". LM providers can use `LanguageModelTextPart` for status, but it becomes visible assistant output.

5. **CallId namespacing**: Our extension prefixes all tool call IDs with `gw-` to avoid collisions with other providers (e.g., Copilot) in the same conversation.

## OpenResponses SSE Event Types

The OpenResponses protocol defines these streaming event types:

### Response Lifecycle Events

- `response.created` - Response object created
- `response.in_progress` - Response processing started
- `response.completed` - Response finished successfully
- `response.failed` - Response failed with error
- `response.incomplete` - Response incomplete (timeout, limit)

### Output Item Events

- `response.output_item.added` - New output item started (text message, function call, etc.)
- `response.output_item.done` - Output item completed

### Content Part Events

- `response.content_part.added` - Content part started within an item
- `response.content_part.done` - Content part completed

### Text Streaming Events

- `response.output_text.delta` - Text chunk
- `response.output_text.done` - Text complete
- `response.output_text.annotation.added` - Citation/annotation added

### Function Call Events

- `response.function_call_arguments.delta` - Argument chunk streamed
- `response.function_call_arguments.done` - Arguments complete

### Reasoning Events (Extended Thinking)

- `response.reasoning.delta` - Reasoning text chunk
- `response.reasoning.done` - Reasoning complete
- `response.reasoning_summary.delta` - Summary chunk
- `response.reasoning_summary.done` - Summary complete
- `response.reasoning_summary_part.added` - Summary part started
- `response.reasoning_summary_part.done` - Summary part completed

### Refusal Events

- `response.refusal.delta` - Refusal text chunk
- `response.refusal.done` - Refusal complete

### Error Events

- `error` - Stream-level error

## State Machine

### Internal State

The stream adapter maintains:

```typescript
interface StreamAdapterState {
  // Function call tracking
  functionCalls: Map<string, FunctionCallState>;
  emittedToolCalls: Set<string>;

  // Text content tracking
  textContent: Map<string, TextContentState>;

  // Reasoning tracking
  reasoningContent: Map<string, string>;
  reasoningSummaries: Map<string, string>;

  // Refusal tracking
  refusalContent: Map<string, string>;

  // Response metadata
  responseId?: string;
  model?: string;
}

interface FunctionCallState {
  callId: string;
  name: string;
  itemId: string;
  argumentsBuffer: string;
}
```

### Event Processing

#### Text Content Flow

```
output_item.added (message)
    │
    └──► Create tracking entry

content_part.added (output_text)
    │
    └──► Initialize text buffer

output_text.delta
    │
    └──► progress.report(new LanguageModelTextPart(delta))

output_text.done
    │
    └──► Clean up buffer (text already emitted incrementally)

output_item.done (message)
    │
    └──► Remove tracking entry
```

#### Function Call Flow

```
output_item.added (function_call)
    │
    ├──► Extract: callId, name, itemId
    └──► functionCalls.set(callId, { callId, name, itemId, argumentsBuffer: "" })

function_call_arguments.delta
    │
    └──► functionCalls.get(callId).argumentsBuffer += delta

function_call_arguments.done                    ← PRIMARY EMISSION POINT
    │
    ├──► IF emittedToolCalls.has(callId): skip
    ├──► Parse arguments from buffer or event
    ├──► functionCalls.delete(callId)
    ├──► emittedToolCalls.add(callId)
    ├──► namespaceCallId(callId) → "gw-" + callId
    └──► progress.report(new LanguageModelToolCallPart(namespacedId, name, args))

output_item.done (function_call)               ← FALLBACK EMISSION POINT
    │
    ├──► functionCalls.delete(callId) (cleanup)
    ├──► IF emittedToolCalls.has(callId): skip (already emitted)
    ├──► Parse arguments from item
    ├──► emittedToolCalls.add(callId)
    ├──► namespaceCallId(callId) → "gw-" + callId
    └──► progress.report(new LanguageModelToolCallPart(namespacedId, name, args))

response.completed (handleCompletion)          ← FINAL FALLBACK
    │
    ├──► Scan response.output for any function_call items
    ├──► FOR each function_call with callId NOT in emittedToolCalls:
    │    ├──► Parse arguments
    │    ├──► emittedToolCalls.add(callId)
    │    └──► progress.report(new LanguageModelToolCallPart(...))
    └──► (Catches any tool calls missed during streaming)
```

#### Reasoning Flow

```
response.reasoning.delta
    │
    └──► progress.report(new LanguageModelTextPart(delta))
         (emitted as plain text - consumers format as needed)

response.reasoning.done
    │
    └──► Cleanup (content already emitted incrementally)
```

### Interleaving Scenarios

#### Parallel Tool Calls

```
SSE Events:                          VS Code Emissions:
─────────────────────────────────    ────────────────────
output_item.added (call1)            (none - tracking only)
output_item.added (call2)            (none - tracking only)
fn_call_args.delta (call1)           (none - buffering)
fn_call_args.delta (call2)           (none - buffering)
fn_call_args.done (call1)      →     ToolCallPart(call1)
fn_call_args.done (call2)      →     ToolCallPart(call2)
output_item.done (call1)             (skip - already emitted)
output_item.done (call2)             (skip - already emitted)
```

#### Text + Tool Call Interleaved

```
SSE Events:                          VS Code Emissions:
─────────────────────────────────    ────────────────────
output_item.added (text)             (none)
content_part.added (text)            (none)
output_text.delta            →       TextPart("Let me ")
output_item.added (call1)            (none - tracking)
output_text.delta            →       TextPart("check that...")
fn_call_args.delta (call1)           (none - buffering)
output_text.done                     (none - cleanup)
fn_call_args.done (call1)    →       ToolCallPart(call1)
output_item.done (text)              (none - cleanup)
output_item.done (call1)             (skip - already emitted)
```

## Gaps and Recommendations

### Gap 1: Missing Tracking Entry (Low Priority)

**Issue:** If `function_call_arguments.done` arrives before we've seen `output_item.added` for that call, we have no tracking entry.

**Terminology note:** This is NOT about SSE delivering events "out of order" - SSE guarantees FIFO delivery over a single connection (TCP/HTTP). This is about the **relative sequencing of different event types** within the protocol.

**Current behavior:** Logs a warning and skips the event.

**Risk:** Low - The OpenResponses server emits events in a consistent order. Not observed in practice.

**Recommendation:** Defer. Add defensive buffering only if this becomes a real issue.

### Gap 2: Citations/Annotations

**Issue:** `output_text.annotation.added` creates inline markdown links. This can disrupt text flow mid-sentence.

**Current behavior:** Emits inline links immediately: ` [title](url)`

**Recommendation:** Document as intentional. Consider buffering annotations as a future enhancement if users report issues.

## Thinking Content (Reasoning Models)

**Status:** Proposed API - not yet available for third-party extensions

VS Code has a `LanguageModelThinkingPart` class for streaming reasoning content from models like Claude with extended thinking or GPT-4.5 with chain-of-thought.

**Current situation:**

- `LanguageModelThinkingPart` exists as a **proposed API** (`languageModelThinkingPart`)
- First-party extensions (Copilot) can use it - this is why thinking "just works" for them
- The Chat Participant consuming our stream would automatically render ThinkingPart as collapsible blocks
- Third-party published extensions **cannot use proposed APIs**

**When it becomes stable:**

- Add `LanguageModelThinkingPart` to our stream for OpenResponses `reasoning` events
- The Chat Participant (not us) handles UI rendering
- No model-specific parsing required - it's a first-class stream part type

**OpenResponses mapping:**

- `output_item.added` with `type: "reasoning"` → Start tracking reasoning item
- `reasoning.delta` → Buffer content (or emit incremental ThinkingPart)
- `reasoning.done` → Emit final `LanguageModelThinkingPart`

## Implementation Checklist

- [x] Add dedupe check in `handleFunctionCallArgumentsDone` ✅ Implemented
- [x] Add dedupe check in `handleOutputItemDone` ✅ Implemented
- [x] Add event sequence logging at TRACE level ✅ Implemented
- [x] CallId namespacing with `gw-` prefix ✅ Implemented
- [x] ~~Add defensive buffering for missing tracking entries~~ (removed - server emits consistent order)

## References

- [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/language-model)
- [LM Provider Stream Semantics](../specs/lm-provider-stream-semantics.md) - Our internal spec for stream behavior
- [OpenResponses Specification](https://www.openresponses.org/)
- [Local LM Types](./appendix/language-model-types.d.ts)
- [Message Translation Mapping](./message-translation-mapping.md)
