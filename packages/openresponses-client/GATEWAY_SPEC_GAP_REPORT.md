# OpenResponses Specification vs Vercel AI Gateway Implementation Gap Report

**Date**: 2025-01-XX  
**Reporter**: [Your name]  
**Gateway Endpoint**: `https://ai-gateway.vercel.sh/v1/responses`

---

## Executive Summary

The Vercel AI Gateway rejects `function_call` items as input to the OpenResponses API, despite the OpenResponses specification explicitly supporting this use case. This prevents clients from preserving full-fidelity tool call history in multi-turn conversations.

---

## The Gap

### OpenResponses Spec Says

From the [OpenResponses specification](https://www.openresponses.org/):

> "Items are bidirectional, they can be provided as inputs to the model, or as outputs from the model."

This means `function_call` items should be valid both as:

- **Output**: Claude returns a `function_call` when it wants to invoke a tool
- **Input**: Client sends the `function_call` back as conversation history

### OpenAPI Schema Confirms

In the OpenAPI spec (`openapi.json`), the `ItemParam` type is defined as a `oneOf` union that explicitly includes `FunctionCallItemParam`:

```json
{
  "oneOf": [
    { "$ref": "#/components/schemas/ItemReferenceParam" },
    { "$ref": "#/components/schemas/ReasoningItemParam" },
    { "$ref": "#/components/schemas/UserMessageItemParam" },
    { "$ref": "#/components/schemas/SystemMessageItemParam" },
    { "$ref": "#/components/schemas/DeveloperMessageItemParam" },
    { "$ref": "#/components/schemas/AssistantMessageItemParam" },
    { "$ref": "#/components/schemas/FunctionCallItemParam" }, // <-- This should be valid input
    { "$ref": "#/components/schemas/FunctionCallOutputItemParam" }
  ]
}
```

### Gateway Implementation Rejects It

When sending a `function_call` item as input, the Gateway returns:

```
400 Bad Request
{
  "error": {
    "message": "input: Invalid input"
  }
}
```

---

## Empirical Test Results

### Test 1: `function_call` as Input Item

**Request:**

```json
{
  "model": "anthropic:claude-sonnet-4-20250514",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": "What time is it?"
    },
    {
      "type": "function_call",
      "call_id": "call_123",
      "name": "get_time",
      "arguments": "{}"
    },
    {
      "type": "function_call_output",
      "call_id": "call_123",
      "output": "{\"time\": \"14:30\"}"
    },
    {
      "type": "message",
      "role": "user",
      "content": "Thanks! And what's the weather in Paris?"
    }
  ],
  "tools": [
    {
      "type": "function",
      "name": "get_time",
      "description": "Get current time",
      "parameters": { "type": "object", "properties": {} }
    },
    {
      "type": "function",
      "name": "get_weather",
      "description": "Get weather",
      "parameters": {
        "type": "object",
        "properties": { "city": { "type": "string" } },
        "required": ["city"]
      }
    }
  ]
}
```

**Expected Result:** Success (per OpenResponses spec)

**Actual Result:** `400 "input: Invalid input"`

### Test 2: Only `function_call_output` (No `function_call`)

**Request:** Same as above, but omitting the `function_call` item

**Result:** Different error from backend:

```
"The number of toolResult blocks at messages.2.content exceeds the number of toolUse blocks of previous turn."
```

This reveals the underlying issue: Anthropic's API requires every `tool_result` to have a matching `tool_use` block in the preceding assistant message. Without `function_call` input items, the Gateway cannot construct proper `tool_use` blocks.

### Test 3: Tool Call as Plain Text (Workaround)

**Request:**

```json
{
  "model": "anthropic:claude-sonnet-4-20250514",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": "What time is it?"
    },
    {
      "type": "message",
      "role": "assistant",
      "content": "[Tool Call: get_time({}) -> call_id: call_123]"
    },
    {
      "type": "message",
      "role": "user",
      "content": "[Tool Result for call_123]: {\"time\": \"14:30\"}"
    },
    {
      "type": "message",
      "role": "user",
      "content": "Thanks! And what's the weather?"
    }
  ]
}
```

**Result:** ✅ Success (but loses tool call fidelity)

---

## Impact

### Who This Affects

Any client that needs to:

1. Pass multi-turn conversation history containing tool calls
2. Use `previous_response_id` to continue a conversation (this may work, untested)
3. Preserve full-fidelity tool call context for Claude's understanding

### Workaround Required

Clients must convert structured tool calls to plain text, losing:

- Structured tool call metadata
- Native Anthropic `tool_use`/`tool_result` block semantics
- Potential context management optimizations

---

## Steps to Reproduce

### Using cURL

```bash
curl -X POST "https://ai-gateway.vercel.sh/v1/responses" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "anthropic:claude-sonnet-4-20250514",
    "input": [
      {
        "type": "message",
        "role": "user",
        "content": "What time is it?"
      },
      {
        "type": "function_call",
        "call_id": "call_123",
        "name": "get_time",
        "arguments": "{}"
      }
    ],
    "tools": [
      {
        "type": "function",
        "name": "get_time",
        "description": "Get the current time",
        "parameters": { "type": "object", "properties": {} }
      }
    ]
  }'
```

**Expected:** 200 OK with response  
**Actual:** 400 "input: Invalid input"

---

## Spec References

1. **OpenResponses Spec**: https://www.openresponses.org/
   - "Items are bidirectional, they can be provided as inputs to the model, or as outputs from the model."

2. **Vercel AI Gateway Docs**: https://vercel.com/docs/ai-gateway/sdks-and-apis/openresponses

3. **OpenAPI Spec**: `ItemParam` oneOf includes `FunctionCallItemParam` (see `openapi.json` lines 720-750)

---

## Suggested Fix

The Gateway should accept `function_call` items as input and translate them to the appropriate Anthropic API format:

1. When receiving a `function_call` input item, include it as a `tool_use` block in an assistant message
2. When receiving a subsequent `function_call_output` item, include it as a `tool_result` block in a user message
3. Ensure `tool_use` blocks have matching `tool_result` blocks as required by Anthropic

This would allow full-fidelity round-trip of tool call history as the OpenResponses spec intends.

---

## Current Workaround

Until this is fixed, clients can convert tool calls/results to plain text messages:

```typescript
// Instead of structured function_call items:
// { type: "function_call", call_id: "x", name: "get_time", arguments: "{}" }

// Send as assistant message text:
{ type: "message", role: "assistant", content: "[Tool Call: get_time({}) -> call_id: x]" }

// And tool results as user message text:
{ type: "message", role: "user", content: "[Tool Result for x]: {\"time\": \"14:30\"}" }
```

This preserves the information but loses structured semantics.
