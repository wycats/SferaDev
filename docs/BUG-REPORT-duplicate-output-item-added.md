# Bug Report: Duplicate `response.output_item.added` Events for Same Tool Call

**Reporter:** Yehuda Katz  
**Date:** January 31, 2026  
**Component:** `ai-gateway/lib/openresponses-compat/convert-aisdk-stream-to-openresponses.ts`  
**Severity:** Medium (likely spec violation, causes downstream deduplication burden)

---

## Summary

The Vercel AI Gateway's OpenResponses stream converter can emit **multiple `response.output_item.added` events** for the same logical tool call, each with a **different `id`** but the **same `call_id`**. This likely violates the OpenResponses specification's implied contract of one `output_item.added` per item.

---

## Spec Interpretation

From the [OpenResponses Specification](https://github.com/openresponses/openresponses/blob/main/src/pages/specification.mdx#L154):

> **"The first event MUST always be `response.output_item.added`. The item is echoed in the payload with as much detail as is available at that time."**

While the spec does not explicitly state "exactly once per item," the language strongly implies a **single** `output_item.added` event per item lifecycle. The word "first" establishes that this event initiates the item's existence in the stream—emitting it multiple times for the same logical tool call creates duplicate items in the response output array, which breaks the expected item state machine.

### Schema Context

From the OpenResponses OpenAPI schema:

- `id`: "The unique ID of the function call item" (e.g., `fc_123`) — the **item identifier**
- `call_id`: "The unique ID of the function tool call that was generated" — the **upstream/model-generated identifier**

When the same `call_id` appears with different `id` values, consumers cannot determine which item is authoritative.

---

## Root Cause

Two independent code paths in `convert-aisdk-stream-to-openresponses.ts` can both fire for the same logical tool call:

| Path          | SDK Event          | Line     | Identifier Used       |
| ------------- | ------------------ | -------- | --------------------- |
| Streaming     | `tool-input-start` | L453-485 | `sdkChunk.id`         |
| Non-streaming | `tool-call`        | L596-655 | `sdkChunk.toolCallId` |

**Both paths:**

1. Generate a **new** `functionCallId` via `generateFunctionCallId()`
2. Emit `response.output_item.added` unconditionally
3. Do **not** check if the tool call was already emitted

The `tool-call` handler (L596) **never consults** the `itemBuffers` map that tracks streaming tool calls, so when both events arrive for the same logical tool call, two separate output items are created.

---

## Code Analysis

### Streaming Path (Lines 453-485)

```typescript
case 'tool-input-start': {
  const callId = sdkChunk.id;                    // ← upstream identifier
  const outputIndex = nextOutputIndex++;
  const functionCallId = generateFunctionCallId(); // ← NEW id every time
  itemBuffers.set(callId, {
    type: 'function_call',
    buffer: '',
    completed: false,
    outputIndex,
    messageId: callId,
    toolName: sdkChunk.toolName,
    functionCallId,
  });

  // Send output_item.added for function_call
  const event: OpenResponsesStreamEvent = {
    type: 'response.output_item.added',
    sequence_number: sequenceNumber++,
    output_index: outputIndex,
    item: {
      type: 'function_call',
      id: functionCallId,
      call_id: callId,
      name: sdkChunk.toolName,
      arguments: '',
      status: 'in_progress',
    },
  };
  controller.enqueue(`event: response.output_item.added\ndata: ${JSON.stringify(event)}\n\n`);
  break;
}
```

### Non-Streaming Path (Lines 596-655)

```typescript
case 'tool-call': {
  // Handle complete tool call (non-streaming version)
  const callId = sdkChunk.toolCallId;            // ← likely same upstream identifier
  const outputIndex = nextOutputIndex++;
  const functionCallId = generateFunctionCallId(); // ← NEW id (no dedup check!)

  const fullArgs = typeof sdkChunk.input === 'string'
    ? sdkChunk.input
    : JSON.stringify(sdkChunk.input);

  // Send output_item.added — WITHOUT checking itemBuffers!
  const addedEvent: OpenResponsesStreamEvent = {
    type: 'response.output_item.added',
    sequence_number: sequenceNumber++,
    output_index: outputIndex,
    item: {
      type: 'function_call',
      id: functionCallId,
      call_id: callId,
      name: sdkChunk.toolName,
      arguments: fullArgs,
      status: 'in_progress',
    },
  };
  controller.enqueue(`event: response.output_item.added\ndata: ${JSON.stringify(addedEvent)}\n\n`);

  // ... continues to emit arguments.done and output_item.done
}
```

### Key Observation

`sdkChunk.id` (streaming) and `sdkChunk.toolCallId` (non-streaming) likely represent the **same logical tool call** from the AI SDK (this assumption needs verification against AI SDK types), but the `tool-call` handler doesn't check `itemBuffers` to see if streaming already emitted an item for this call.

**Note:** The Anthropic-compat converter in this same codebase already includes deduplication logic for this scenario, suggesting this is a known issue pattern.

---

## Reproduction Scenario

This bug manifests when the AI SDK emits **both** streaming and non-streaming events for the same tool call:

1. Model starts streaming a tool call → `tool-input-start` fires → `output_item.added` emitted with `id: "fc_abc"`
2. Model completes the tool call → `tool-call` fires → `output_item.added` emitted with `id: "fc_xyz"`

Result: Two items in the output array with:

- Different `id` values (`fc_abc`, `fc_xyz`)
- Same `call_id` value
- Same tool name and arguments

---

## Impact

### For Downstream Consumers

1. **Duplicate tool calls in output array** — Consumers counting tool calls will over-count
2. **Correlation failures** — `output_item.done` may reference a different `id` than expected
3. **State inconsistency** — When `id` differs but `call_id` matches, which item is authoritative?

### Current Workaround

The SferaDev VS Code extension works around this by deduplicating on **both** `id` (the item identifier) **and** `call_id` (the upstream identifier). This defensive programming catches duplicates regardless of which identifier varies.

---

## Recommended Fix

### 1. Add Cross-Path Deduplication State

```typescript
// Add near the top of the transform function
const emittedToolCalls = new Map<
  string,
  {
    functionCallId: string;
    outputIndex: number;
    emittedAdded: boolean;
  }
>();
```

### 2. Modify `tool-input-start` Handler

```typescript
case 'tool-input-start': {
  const callId = sdkChunk.id;

  // Check if already tracking this tool call
  let toolCallState = emittedToolCalls.get(callId);
  if (!toolCallState) {
    const functionCallId = generateFunctionCallId();
    const outputIndex = nextOutputIndex++;
    toolCallState = { functionCallId, outputIndex, emittedAdded: false };
    emittedToolCalls.set(callId, toolCallState);
  }

  // Also update itemBuffers for streaming deltas
  itemBuffers.set(callId, {
    type: 'function_call',
    buffer: '',
    completed: false,
    outputIndex: toolCallState.outputIndex,
    messageId: callId,
    toolName: sdkChunk.toolName,
    functionCallId: toolCallState.functionCallId,
  });

  if (!toolCallState.emittedAdded) {
    toolCallState.emittedAdded = true;
    // Emit output_item.added ONCE
    const event: OpenResponsesStreamEvent = { ... };
    controller.enqueue(...);
  }
  break;
}
```

### 3. Modify `tool-call` Handler

```typescript
case 'tool-call': {
  const callId = sdkChunk.toolCallId;

  // Check if streaming already handled this tool call
  let toolCallState = emittedToolCalls.get(callId);

  if (toolCallState?.emittedAdded) {
    // Streaming already emitted output_item.added
    // Only emit arguments.done and output_item.done using existing IDs
    const argsEvent: OpenResponsesStreamEvent = {
      type: 'response.function_call_arguments.done',
      item_id: toolCallState.functionCallId,  // ← reuse existing ID
      output_index: toolCallState.outputIndex,
      // ...
    };
    // ... emit done events only
    return;
  }

  // First time seeing this tool call - emit full lifecycle
  if (!toolCallState) {
    const functionCallId = generateFunctionCallId();
    const outputIndex = nextOutputIndex++;
    toolCallState = { functionCallId, outputIndex, emittedAdded: true };
    emittedToolCalls.set(callId, toolCallState);
  }

  // Emit output_item.added, arguments.done, output_item.done
  // ... using toolCallState.functionCallId consistently
}
```

---

## Test Case Suggestion

Add a test that verifies deduplication:

```typescript
it("should emit only one output_item.added when both tool-input-start and tool-call fire", async () => {
  const chunks = [
    { type: "tool-input-start", id: "call_123", toolName: "get_weather" },
    { type: "tool-input-delta", id: "call_123", delta: '{"loc' },
    { type: "tool-input-delta", id: "call_123", delta: 'ation":"NYC"}' },
    {
      type: "tool-call",
      toolCallId: "call_123",
      toolName: "get_weather",
      input: { location: "NYC" },
    },
  ];

  const events = await collectStreamEvents(chunks);

  const addedEvents = events.filter(
    (e) => e.type === "response.output_item.added",
  );
  expect(addedEvents).toHaveLength(1); // NOT 2!

  // All events should reference the same item ID
  const itemIds = new Set(
    events.map((e) => e.item?.id || e.item_id).filter(Boolean),
  );
  expect(itemIds.size).toBe(1);
});
```

---

## Additional Issues Found During Review

### 1. `item_id` Mismatch in Done Events

The `function_call_arguments.done` and `output_item.done` events use `callId` (the upstream identifier) as `item_id`, but `output_item.added` uses `functionCallId` as the item's `id`. This inconsistency may cause cross-event correlation issues:

```typescript
// In output_item.added:
item: { id: functionCallId, call_id: callId, ... }

// In function_call_arguments.done:
item_id: callId  // ← Should this be functionCallId?
```

### 2. `tool-input-delta`/`tool-input-end` Fallback Paths

When `tool-input-delta` or `tool-input-end` arrives without a prior `tool-input-start`, these handlers also generate new `functionCallId` values and emit `output_item.added`. The fix should address these paths as well.

### 3. Precedent in Anthropic-Compat Converter

The `convert-aisdk-stream-to-anthropic.ts` converter in the same codebase **already includes deduplication logic** for this exact scenario. This confirms the pattern is known and the fix approach is sound.

**From `lib/anthropic-compat/convert-aisdk-stream-to-anthropic.ts`:**

```typescript
// Line 29-30: Track seen tool_use IDs to deduplicate (workaround for Claude model bug)
const seenToolUseIds = new Set<string>();

// Lines 150-154: Deduplication in tool-input-start handler
case 'tool-input-start': {
  // Deduplicate tool_use blocks with the same ID (workaround for Claude model bug)
  if (seenToolUseIds.has(sdkChunk.id)) {
    // Skip this tool_use block entirely - don't emit any events for it
    break;
  }
  seenToolUseIds.add(sdkChunk.id);
  // ... rest of handler
}

// Lines 238-241: Deduplication in tool-call handler
case 'tool-call': {
  // Deduplicate tool_use blocks with the same ID (workaround for Claude model bug)
  if (seenToolUseIds.has(sdkChunk.toolCallId)) {
    break;
  }
  seenToolUseIds.add(sdkChunk.toolCallId);
  // ... rest of handler
}
```

The OpenResponses converter (`convert-aisdk-stream-to-openresponses.ts`) is **missing this exact pattern**. The fix should add an equivalent `seenToolCallIds` Set and check it in both `tool-input-start` and `tool-call` handlers.

---

## Assumptions Requiring Verification

1. **Identifier equivalence:** We assume `sdkChunk.id` (streaming) and `sdkChunk.toolCallId` (non-streaming) are the same logical identifier. This should be verified against AI SDK v3 type definitions.

2. **Dual emission behavior:** We assume the AI SDK can emit both `tool-input-start` AND `tool-call` for the same tool call. This should be verified with AI SDK documentation or testing.

---

## Files to Modify

1. **`lib/openresponses-compat/convert-aisdk-stream-to-openresponses.ts`** — Add cross-path deduplication
2. **`lib/openresponses-compat/convert-aisdk-stream-to-openresponses.test.ts`** — Add test case for duplicate prevention

---

## References

- [OpenResponses Specification - Items are streamable](https://github.com/openresponses/openresponses/blob/main/src/pages/specification.mdx#L152-L180)
- [OpenResponses OpenAPI Schema - function_call item](https://github.com/openresponses/openresponses/blob/main/schema/openapi.yaml)
- [AI SDK v3 Stream Parts Documentation](https://sdk.vercel.ai/docs)
