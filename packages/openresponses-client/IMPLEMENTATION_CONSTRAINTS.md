# OpenResponses API Implementation Constraints

> **Last Updated**: 2026-01-31
>
> This document describes constraints discovered through empirical testing of the
> **Vercel AI Gateway** implementation of the OpenResponses API that are NOT
> documented in the OpenAPI specification ([openapi.json](./openapi.json)).

## ⚠️ Critical: OpenAPI Spec vs Implementation

The OpenAPI spec defines the **theoretical schema** for the OpenResponses API.
However, the actual Vercel AI Gateway implementation has additional constraints
that cause 400 "Invalid input" errors or model behavior issues if violated.

**Source**: Empirical testing against `https://ai-gateway.vercel.sh/v1/responses`
and analysis of [vercel/ai-gateway](https://github.com/vercel/ai-gateway) source code.

---

## Gateway Architecture Constraints

### 1. `instructions` Field is OpenAI-Only

**OpenAPI Spec Says**: The `instructions` field provides system-level guidance.

**Reality**: The Vercel AI Gateway only passes `instructions` to OpenAI providers
via `providerOptions.openai.instructions`. Non-OpenAI providers (Anthropic, Bedrock,
Vertex AI) **never receive** this field.

**Source**: [vercel/ai-gateway - convert-to-aisdk-call-options.ts#L70-72](https://github.com/vercel/ai-gateway/blob/main/lib/openresponses-compat/convert-to-aisdk-call-options.ts#L70-72)

```typescript
// This is the ONLY place instructions is used:
openaiOptions.instructions = request.instructions;
// It goes to providerOptions.openai - NOT to the prompt!
```

**Implication**: If you rely on `instructions` for system prompts, Anthropic models
will receive the conversation WITHOUT the system prompt. This causes the "pause"
behavior where the model outputs minimal text and stops.

**Workaround**: Prepend a `developer` role message to the input array. The gateway
correctly converts `developer` → `system` for all providers including Anthropic.

```json
{
  "model": "anthropic/claude-opus-4.5",
  "instructions": "System prompt here", // Still set for OpenAI compat
  "input": [
    {
      "type": "message",
      "role": "developer", // ← Prepend this for universal provider support
      "content": "System prompt here"
    }
    // ... rest of conversation
  ]
}
```

---

### 2. Consecutive Same-Role Messages Can Cause Model Confusion

**Observed Behavior**: In some model/provider combinations, multiple consecutive
messages with the same role (e.g., `user, user, user`) can lead to degraded
behavior. However, the gateway **accepts** consecutive same-role messages without
validation errors.

- Output minimal text like "Now let's run the tests:" and stop
- Fail to call tools even when tools are clearly needed
- Return `stop_reason: "stop"` with 10-30 output tokens

**Root Cause**: This appears to be a model-level behavior rather than an API
constraint. Some providers (notably Anthropic) are more sensitive to alternating
roles, but the gateway does not enforce alternation.

**Common Trigger**: Tool results being emitted as separate user messages creates
`assistant → user → user → user` patterns when multiple tools are called.

**Optional Workaround**: Consolidate consecutive same-role messages into a
single message if you observe degraded model behavior:

```typescript
// BAD: Creates user, user, user pattern
[
  { role: "user", content: "Attachment context..." },
  { role: "user", content: "Tool result 1..." },
  { role: "user", content: "Tool result 2..." },
][
  // GOOD: Consolidated into single user message
  {
    role: "user",
    content:
      "Attachment context...\n\n---\n\nTool result 1...\n\n---\n\nTool result 2...",
  }
];
```

---

## Input Item Constraints

### 3. `function_call` IS Now a Valid Input Item ✅

**OpenAPI Spec Says**: `ItemParam` is a union that includes `FunctionCallItemParam`

**Previous Reality (before 2026-01-31)**: The gateway rejected `function_call` in input.

**Current Reality (as of 2026-01-31)**: The Vercel AI Gateway now accepts `function_call`
items in the input array. This allows proper reconstruction of tool call history.

**Verified Working Pattern**:

```json
{
  "input": [
    { "type": "message", "role": "user", "content": "What time is it?" },
    {
      "type": "function_call",
      "call_id": "call_123",
      "name": "get_time",
      "arguments": "{}"
    },
    {
      "type": "function_call_output",
      "call_id": "call_123",
      "output": "3:00 PM"
    },
    { "type": "message", "role": "user", "content": "Thanks!" }
  ]
}
```

### 1a. Additional OpenAI-Only Pass-Through Fields

In addition to `instructions`, the gateway treats the following fields as
OpenAI-only pass-throughs. They are forwarded via `providerOptions.openai` and
are ignored by non-OpenAI providers:

- `parallel_tool_calls`
- `metadata`
- `previous_response_id`

**Source**: [convert-to-aisdk-call-options.ts#L66-78](https://github.com/vercel/ai-gateway/blob/main/lib/openresponses-compat/convert-to-aisdk-call-options.ts#L66-78)

```typescript
// All of these go to providerOptions.openai only:
openaiOptions.parallelToolCalls = request.parallel_tool_calls;
openaiOptions.instructions = request.instructions;
openaiOptions.metadata = request.metadata;
openaiOptions.previousResponseId = request.previous_response_id;
```

**Implication**: `metadata` and `previous_response_id` are passed through to OpenAI
but are completely ignored when using Anthropic or other non-OpenAI providers.

### 1b. Metadata Field Limits

The `metadata` field has strict validation limits:

| Limit            | Value          | Error Message                                       |
| ---------------- | -------------- | --------------------------------------------------- |
| Max keys         | 16             | "Metadata cannot have more than 16 keys"            |
| Max key length   | 64 characters  | "Metadata keys cannot exceed 64 characters"         |
| Max value length | 512 characters | "Too big: expected string to have <=512 characters" |
| Value type       | strings only   | Zod type validation error                           |

**Source**: Gateway validation in `lib/openresponses-compat/openresponses-compat-api-types.ts`

**Verified**: 2026-01-31 via empirical testing

**Important**: The `function_call` item can appear directly after a user message;
an explicit assistant message is no longer required before the tool call.

**Hallucination Warning**: While tool calls can now be properly represented in
history, do NOT include text representations of tool calls in assistant message
content. This causes the model to mimic the format, producing hallucinated calls.

---

### 4. Assistant Message Content Format

**OpenAPI Spec Says**: Assistant messages can have:

- `content: string`
- `content: OutputTextContentParam[]` (array with `type: "output_text"`)

**Reality**: For INPUT messages, the implementation accepts:

- `content: string` ✅ (preferred, most reliable)
- `content: InputTextContentParam[]` with `type: "input_text"` ✅
- `content: OutputTextContentParam[]` with `type: "output_text"` ✅

Both `input_text` and `output_text` arrays are accepted for assistant messages
in input.

**Recommendation**: Prefer plain string content for assistant messages in input:

```json
{
  "type": "message",
  "role": "assistant",
  "content": "This is the assistant's response"
}
```

### 3a. Invalid `function_call` Arguments Are Coerced

If the `arguments` field in a `function_call` input item contains invalid JSON,
the gateway coerces it to an empty object `{}` rather than rejecting the request.

**Verified**: 2026-01-31 - Request with `"arguments": "invalid json here"` was
accepted and the model continued normally.

**Source**: Gateway code in `lib/openresponses-compat/convert-to-aisdk-call-options.ts`

---

### 5. `function_call_output` and Preceding `function_call`

**OpenAPI Spec Says**: `function_call_output` is a standalone item type.

**Reality**: The gateway accepts orphaned `function_call_output` items, but the
underlying LLM providers (Anthropic, OpenAI) often expect tool results to have
corresponding tool_use/tool_call blocks. The gateway does NOT synthesize these
from `function_call_output` alone.

### 5a. `function_call_output` Uses `toolName: "unknown"`

When converting `function_call_output` to the AI SDK format, the gateway sets
`toolName: "unknown"` because the OpenResponses schema for `function_call_output`
does not include the tool name - only the `call_id` and `output`.

**Source**: [convert-to-aisdk-call-options.ts#L260-266](https://github.com/vercel/ai-gateway/blob/main/lib/openresponses-compat/convert-to-aisdk-call-options.ts#L260-266)

```typescript
const toolResult: LanguageModelV3ToolResultPart = {
  type: "tool-result",
  toolCallId: item.call_id,
  toolName: "unknown", // OpenResponses doesn't include tool name in output
  output,
};
```

**Implication**: This reinforces the recommendation to include corresponding
`function_call` items before `function_call_output` items. The `function_call`
item provides the tool name, ensuring proper tool call reconstruction.

**Error Example** (from Anthropic API via Vercel AI Gateway):

```
"The number of toolResult blocks at messages.2.content exceeds
the number of toolUse blocks of previous turn."
```

**Recommendation**: Include the corresponding `function_call` item before
`function_call_output` to avoid provider-level errors or degraded results:

```json
{
  "input": [
    { "type": "message", "role": "user", "content": "..." },
    {
      "type": "function_call",
      "call_id": "call_123",
      "name": "tool_name",
      "arguments": "{}"
    },
    {
      "type": "function_call_output",
      "call_id": "call_123",
      "output": "result"
    }
  ]
}
```

**This is now the recommended approach** since `function_call` is accepted as input.

---

## Message Role Constraints

### 6. `developer` Role Works Universally

**Verified**: `role: "developer"` messages are converted to `system` role messages
by the gateway for all providers including Anthropic. This is the recommended way
to deliver system prompts when using non-OpenAI providers.

---

### 7. `system` Role in Input Messages

**OpenAPI Spec Says**: `role: "system"` is a valid message role.

**Gateway Behavior**: The gateway converts `system` role messages to the appropriate
format for each provider. However, using `developer` is preferred for clarity.

---

## Content Type Constraints

### 8. Input Content Types

For **input** messages (user, assistant, developer), use:

- `input_text` for text content
- `input_image` for images
- `input_file` for files

### 8a. `input_image.detail` Field is Ignored

**OpenAPI Spec Says**: The `input_image` type has an optional `detail` field with
values `"auto"`, `"low"`, or `"high"`.

**Reality**: The gateway accepts the `detail` field in the schema but completely
ignores it during conversion. Only `image_url` is extracted from `input_image`.

**Source**: [convert-to-aisdk-call-options.ts#L182-190](https://github.com/vercel/ai-gateway/blob/main/lib/openresponses-compat/convert-to-aisdk-call-options.ts#L182-190)

```typescript
} else if (part.type === 'input_image') {
  // Handle input_image format (URL or base64 data URL)
  if (part.image_url) {
    content.push({
      type: 'file',
      data: part.image_url,
      mediaType: 'image/*',
    });
  }
  // Note: part.detail is NOT used
}
```

**Implication**: Do not rely on `detail` to control image processing. The underlying
provider may have its own default behavior.

**Additional gateway filtering behavior** (based on code review):

- **User messages**: The gateway only processes `input_text`, `input_image`,
  `input_file`, and `input_video`. Other content types (including `output_text`)
  are ignored.
- **Assistant messages (input)**: The gateway retains only `input_text` and
  `output_text` parts. Non-text content types are filtered out.
- **Empty assistant content**: If an assistant message has no text parts after
  filtering, the gateway injects an empty text part: `{ type: 'text', text: '' }`.
  This ensures assistant messages always have at least one content part.
- **System/developer messages**: Only `input_text` is processed; other content
  types are filtered out.

### 9. Output Content Types

The API **returns** (in responses):

- `output_text` for text content
- `output_image` for images
- `function_call` as separate output items

---

## Input Validation Constraints

### 10. User Message Required

At least one `user` role message is required in the input array.

**Error**: "At least one user message is required in the input"
**Status**: 400

**Source**: Gateway validation in `lib/openresponses-compat/openresponses-compat-api-types.ts`

### 11. Non-Empty Input Array

The `input` array must contain at least one item. Empty arrays are rejected.

**Error**: "input: Too small: expected array to have >=1 items"
**Status**: 400

### 12. allowed_tools Must Reference Defined Tools

If `allowed_tools` is specified, each tool name must exist in the `tools` array.

**Error**: "allowed_tools contains undefined tools: [tool_name]"
**Status**: 400

---

## Empirical Test Results

### Tested: 2026-01-31 (verified)

| Payload Type                                    | Result       | Notes                           |
| ----------------------------------------------- | ------------ | ------------------------------- |
| Minimal user message                            | ✅ Success   | Basic case works                |
| Developer + user messages                       | ✅ Success   | `role: "developer"` works       |
| Message with tools defined                      | ✅ Success   | Tool schema accepted            |
| Multi-turn with string assistant content        | ✅ Success   | Preferred format                |
| Multi-turn with `output_text` array             | ✅ Success   | Accepted for assistant input    |
| `function_call` as input item                   | ✅ Success   | **NOW WORKS** (gateway updated) |
| `function_call` + `function_call_output` pair   | ✅ Success   | **Recommended approach**        |
| `function_call_output` alone (no function_call) | ⚠️ Degraded  | Provider-level confusion        |
| Consecutive user messages (3+)                  | ✅ Success   | Behavioral issues possible      |
| `instructions` field with Anthropic             | ⚠️ Ignored   | Not passed to non-OpenAI        |
| `developer` message with Anthropic              | ✅ Success   | Converted to system message     |
| 17 metadata keys                                | ❌ 400 Error | Max 16 keys                     |
| 65-char metadata key                            | ❌ 400 Error | Max 64 chars                    |
| 513-char metadata value                         | ❌ 400 Error | Max 512 chars                   |
| No user message                                 | ❌ 400 Error | User message required           |
| Empty input array                               | ❌ 400 Error | Min 1 item                      |
| Invalid tool in allowed_tools                   | ❌ 400 Error | Must match tools[]              |
| Invalid JSON in function_call args              | ✅ Success   | Coerced to {}                   |
| `metadata` with Anthropic                       | ⚠️ Ignored   | OpenAI-only (code verified)     |
| `previous_response_id` with Anthropic           | ⚠️ Ignored   | OpenAI-only (code verified)     |
| `input_image` with `detail` field               | ⚠️ Ignored   | `detail` not passed to provider |

---

## Recommendations for Client Implementations

1. **For system prompts**: Prepend a `developer` role message AND set `instructions`
   for maximum compatibility across all providers.

2. **For tool calls in history**: Use `function_call` + `function_call_output` pairs.
   This is now supported and is the cleanest approach.

3. **For assistant messages in history**: Prefer plain string `content`. Arrays
   with `input_text` or `output_text` are accepted, but keep them text-only.
   Do NOT include tool call text representations - this causes hallucinations.

4. **For user messages**: Use `input_text` for text content. `output_text` parts
   are ignored for user messages by the gateway.

5. **Avoid in assistant content**:
   - Tool call summaries like `[Tool Call: ...]`
   - JSON representations of tool calls
   - Any structured format the model might mimic

> **Note**: These recommendations are based on empirical testing and may change
> as the Vercel AI Gateway implementation evolves.

---

## Version Information

- **Vercel AI Gateway**: Tested against production endpoint (ai-gateway.vercel.sh)
- **Date**: 2026-01-31
- **OpenAPI Spec Version**: See [openapi.json](./openapi.json)
