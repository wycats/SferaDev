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
  "instructions": "System prompt here",  // Still set for OpenAI compat
  "input": [
    {
      "type": "message",
      "role": "developer",  // ← Prepend this for universal provider support
      "content": "System prompt here"
    },
    // ... rest of conversation
  ]
}
```

---

### 2. Consecutive Same-Role Messages Cause Model Confusion

**Observed Behavior**: When multiple consecutive messages have the same role
(e.g., `user, user, user`), Claude models may:
- Output minimal text like "Now let's run the tests:" and stop
- Fail to call tools even when tools are clearly needed
- Return `stop_reason: "stop"` with 10-30 output tokens

**Root Cause**: The Anthropic API expects alternating user/assistant messages.
While the API may accept consecutive same-role messages, the model's behavior
degrades significantly.

**Common Trigger**: Tool results being emitted as separate user messages creates
`assistant → user → user → user` patterns when multiple tools are called.

**Workaround**: Consolidate consecutive same-role messages into a single message
before sending to the API:

```typescript
// BAD: Creates user, user, user pattern
[
  { role: "user", content: "Attachment context..." },
  { role: "user", content: "Tool result 1..." },
  { role: "user", content: "Tool result 2..." }
]

// GOOD: Consolidated into single user message
[
  { role: "user", content: "Attachment context...\n\n---\n\nTool result 1...\n\n---\n\nTool result 2..." }
]
```

---

## Input Item Constraints

### 3. `function_call` is NOT a Valid Input Item

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
you CANNOT pass `function_call` items back to the API. Tool calls are OUTPUT-only.

**Critical Note on Hallucination Risk**: Do NOT include tool call summaries or
representations in assistant message content. This causes the model to mimic
the tool call format in its output, producing hallucinated tool calls that
don't match the schema or contain invalid arguments.

---

### 4. Assistant Message Content Format

**OpenAPI Spec Says**: Assistant messages can have:

- `content: string`
- `content: OutputTextContentParam[]` (array with `type: "output_text"`)

**Reality**: For INPUT messages, the implementation expects:

- `content: string` ✅ (preferred, most reliable)
- `content: InputTextContentParam[]` with `type: "input_text"` ✅

Using `output_text` in input assistant messages causes validation errors.

**Recommendation**: Always use plain string content for assistant messages in input:

```json
{
  "type": "message",
  "role": "assistant",
  "content": "This is the assistant's response"
}
```

---

### 5. `function_call_output` Requires Preceding Context

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
`tool_use` blocks when converting to AI SDK format.

**Current Strategy**: Emit tool results as user message content with context prefix.
This works but creates consecutive user messages (see constraint #2).

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

Do NOT use `output_text` in input messages.

### 9. Output Content Types

The API **returns** (in responses):

- `output_text` for text content
- `output_image` for images
- `function_call` as separate output items

---

## Empirical Test Results

### Tested: 2026-01-31

| Payload Type                                        | Result            | Notes                        |
| --------------------------------------------------- | ----------------- | ---------------------------- |
| Minimal user message                                | ✅ Success        | Basic case works             |
| Developer + user messages                           | ✅ Success        | `role: "developer"` works    |
| Message with tools defined                          | ✅ Success        | Tool schema accepted         |
| Multi-turn with string assistant content            | ✅ Success        | Preferred format             |
| Multi-turn with `output_text` array                 | ❌ 400 Error      | Wrong content type for input |
| `function_call` as input item                       | ❌ 400 Error      | Not in input schema          |
| `function_call_output` alone (no assistant context) | ❌ Provider Error | Missing tool_use context     |
| Consecutive user messages (3+)                      | ⚠️ Degraded       | Model stops early            |
| `instructions` field with Anthropic                 | ⚠️ Ignored        | Not passed to non-OpenAI     |
| `developer` message with Anthropic                  | ✅ Success        | Converted to system message  |

---

## Recommendations for Client Implementations

1. **For system prompts**: Prepend a `developer` role message AND set `instructions`
   for maximum compatibility across all providers.

2. **For assistant messages in history**: Use plain string `content`, not arrays.
   Do NOT include tool call representations - this causes hallucinations.

3. **For tool results in history**: Convert to user message text. However, be aware
   this creates consecutive user messages if multiple tools are called.

4. **For message structure**: Consolidate consecutive same-role messages before
   sending to avoid model confusion (especially with Claude models).

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

