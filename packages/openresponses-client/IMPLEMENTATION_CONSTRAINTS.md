# OpenResponses API Implementation Constraints

> **Last Updated**: 2026-01-29
>
> This document describes constraints discovered through empirical testing of the
> **Vercel AI Gateway** implementation of the OpenResponses API that are NOT
> documented in the OpenAPI specification ([openapi.json](./openapi.json)).

## ⚠️ Critical: OpenAPI Spec vs Implementation

The OpenAPI spec defines the **theoretical schema** for the OpenResponses API.
However, the actual Vercel AI Gateway implementation has additional constraints
that cause 400 "Invalid input" errors if violated.

**Source**: Empirical testing against `https://ai-gateway.vercel.sh/v1/responses`
and analysis of [vercel/ai-gateway](https://github.com/vercel/ai-gateway) source code.

---

## Input Item Constraints

### 1. `function_call` is NOT a Valid Input Item

**OpenAPI Spec Says**: `ItemParam` is a union that includes `FunctionCallItemParam`

**Reality**: The Vercel AI Gateway `inputItemSchema` only accepts:

- `functionCallOutputItemSchema` (for `function_call_output`)
- `messageInputItemSchema` (for `message`)

**Source**: [vercel/ai-gateway - openresponses-compat-api-types.ts](https://github.com/vercel/ai-gateway/blob/main/lib/openresponses-compat/openresponses-compat-api-types.ts#L51-L54)

```typescript
const inputItemSchema = z.union([
  functionCallOutputItemSchema, // ✅ Accepted
  messageInputItemSchema, // ✅ Accepted
  // NO function_call!           // ❌ NOT accepted as input
]);
```

**Implication**: When reconstructing conversation history that includes tool calls,
you CANNOT pass `function_call` items back to the API. Tool calls are OUTPUT-only items.

**Workaround**: Embed tool call context in assistant message text, or omit tool call
history entirely (the `function_call_output` still works as the model can infer context).

---

### 2. Assistant Message Content Format

**OpenAPI Spec Says**: Assistant messages can have:

- `content: string`
- `content: OutputTextContentParam[]` (array with `type: "output_text"`)

**Reality**: For INPUT messages, the implementation expects:

- `content: string` ✅ (preferred, most reliable)
- `content: InputTextContentParam[]` with `type: "input_text"` ✅

Using `output_text` in input assistant messages causes validation errors.

**Source**: [vercel/ai-gateway - convert-to-aisdk-call-options.ts](https://github.com/vercel/ai-gateway/blob/main/lib/openresponses-compat/convert-to-aisdk-call-options.ts#L190-L195)

```typescript
// Assistant messages - extract text and function calls
for (const part of contentArray) {
  if (part.type === "input_text") {
    // Uses input_text, not output_text!
    content.push({ type: "text", text: part.text });
  }
}
```

**Recommendation**: Always use plain string content for assistant messages in input:

```json
{
  "type": "message",
  "role": "assistant",
  "content": "This is the assistant's response"
}
```

---

### 3. `function_call_output` Requires Preceding Context

**OpenAPI Spec Says**: `function_call_output` is a standalone item type.

**Reality**: The underlying LLM providers (Anthropic, OpenAI) expect tool results
to have corresponding tool_use/tool_call blocks in the preceding assistant message.

**Error Example** (from Anthropic API via Vercel AI Gateway):

```
"The number of toolResult blocks at messages.2.content exceeds
the number of toolUse blocks of previous turn."
```

**Analysis**: The OpenResponses input schema does support `function_call_output`,
but the current Vercel AI Gateway implementation doesn't synthesize the corresponding
`tool_use` blocks when converting to AI SDK format. The Gateway _could_ do this by:

1. Tracking `function_call_output` items and their `call_id` values
2. Synthesizing matching `tool-call` blocks in the preceding assistant message

This is a **Gateway implementation gap**, not an inherent API limitation.

**Current Workaround**: Convert tool call/result pairs to text in messages:

```json
{
  "type": "message",
  "role": "assistant",
  "content": "Let me check the time.\n\n[Tool Call: get_time({}) -> call_id: call_123]"
},
{
  "type": "message",
  "role": "user",
  "content": "[Tool Result for call_123]: The current time is 3:00 PM"
}
```

This preserves the semantic meaning while working around the current Gateway behavior.

---

## Message Role Constraints

### 4. `system` Role Behavior

**OpenAPI Spec Says**: `role: "system"` is a valid message role.

**Observed Behavior**: Works, but the preferred approach is to use the `instructions`
field at the request level for system prompts.

**Recommendation**: Use `instructions` field for system prompts:

```json
{
  "model": "anthropic/claude-sonnet-4",
  "instructions": "You are a helpful assistant.",
  "input": [...]
}
```

---

### 5. `developer` Role Works as Expected

**Verified**: `role: "developer"` messages work correctly for instruction-like
content within the conversation flow.

---

## Content Type Constraints

### 6. Input Content Types

For **input** messages (user, assistant, developer), use:

- `input_text` for text content
- `input_image` for images
- `input_file` for files

Do NOT use `output_text` in input messages.

### 7. Output Content Types

The API **returns** (in responses):

- `output_text` for text content
- `output_image` for images
- `function_call` as separate output items

---

## Empirical Test Results

### Tested: 2026-01-29

| Payload Type                                        | Result            | Notes                        |
| --------------------------------------------------- | ----------------- | ---------------------------- |
| Minimal user message                                | ✅ Success        | Basic case works             |
| Developer + user messages                           | ✅ Success        | `role: "developer"` works    |
| Message with tools defined                          | ✅ Success        | Tool schema accepted         |
| Multi-turn with string assistant content            | ✅ Success        | Preferred format             |
| Multi-turn with `output_text` array                 | ❌ 400 Error      | Wrong content type for input |
| `function_call` as input item                       | ❌ 400 Error      | Not in input schema          |
| `function_call_output` alone (no assistant context) | ❌ Provider Error | Missing tool_use context     |
| `function_call_output` with text-embedded tool call | ❌ Provider Error | Text != real tool_use block  |
| Tool call + result as text in messages              | ✅ Success        | **Recommended approach**     |

---

## Recommendations for Client Implementations

1. **For assistant messages in history**: Use plain string `content`, not arrays.

2. **For tool calls in history**: Embed in assistant message text:

   ```
   [Tool Call: tool_name({"arg": "value"}) -> call_id: call_xxx]
   ```

3. **For tool results in history**: Convert to user message text (workaround for current Gateway behavior):

   ```
   [Tool Result for call_xxx]: The result value here
   ```

4. **For system prompts**: Prefer the `instructions` field over `role: "system"`.

> **Note**: Recommendation #3 is a workaround for the current Vercel AI Gateway
> implementation. The Gateway could potentially be updated to synthesize
> `tool_use` blocks from `function_call_output` context, which would allow
> using `function_call_output` items directly.

---

## Version Information

- **Vercel AI Gateway**: Tested against production endpoint (ai-gateway.vercel.sh)
- **Date**: 2026-01-29
- **OpenAPI Spec Version**: See [openapi.json](./openapi.json)
