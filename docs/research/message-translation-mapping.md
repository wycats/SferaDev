# Message Translation Mapping: VS Code → OpenResponses

> **Last Updated**: 2026-01-29
>
> **Reference Documentation**:
>
> - VS Code Language Model API: [docs/research/language-model-types.d.ts](../language-model-types.d.ts)
> - OpenResponses API Spec: [packages/openresponses-client/openapi.json](../../../packages/openresponses-client/openapi.json)
> - **Implementation Constraints**: [packages/openresponses-client/IMPLEMENTATION_CONSTRAINTS.md](../../../packages/openresponses-client/IMPLEMENTATION_CONSTRAINTS.md)
> - OpenResponses Zod Schemas: [packages/openresponses-client/src/generated/schemas.ts](../../../packages/openresponses-client/src/generated/schemas.ts)

This document defines the canonical mapping from VS Code Language Model API types to OpenResponses API types.

---

## ⚠️ Critical Implementation Notes

Before reading the type mappings, understand these constraints discovered through
empirical testing (see [IMPLEMENTATION_CONSTRAINTS.md](../../../packages/openresponses-client/IMPLEMENTATION_CONSTRAINTS.md)):

1. **`function_call` is NOT a valid input item** - Only `message` and `function_call_output` are accepted
2. **Assistant messages must use string or `input_text` content** - NOT `output_text` (that's for responses only)
3. **Tool results need context** - `function_call_output` without preceding tool_use context may fail at provider level

---

## VS Code Types

### LanguageModelChatMessageRole

- Enum values:
  - `User` = 1
  - `Assistant` = 2
- No `system`, `developer`, or `tool` roles exist in the VS Code API.

### LanguageModelChatMessage

- Structure:
  - `role: LanguageModelChatMessageRole`
  - `content: LanguageModelInputPart[]`
  - `name?: string`
- The constructor accepts either a string or an array of parts.
- Helper factories:
  - `LanguageModelChatMessage.User(...)` allows `LanguageModelTextPart`, `LanguageModelToolResultPart`, `LanguageModelDataPart`
  - `LanguageModelChatMessage.Assistant(...)` allows `LanguageModelTextPart`, `LanguageModelToolCallPart`, `LanguageModelDataPart`

### Content Part Types

- `LanguageModelInputPart` union:
  - `LanguageModelTextPart`
  - `LanguageModelToolCallPart`
  - `LanguageModelToolResultPart`
  - `LanguageModelDataPart`

#### LanguageModelTextPart

- `value: string`

#### LanguageModelToolCallPart

- `callId: string`
- `name: string`
- `input: object`

#### LanguageModelToolResultPart

- `callId: string`
- `content: (LanguageModelTextPart | LanguageModelPromptTsxPart | LanguageModelDataPart | unknown)[]`
- Only valid in **user** message content.

#### LanguageModelDataPart

- `mimeType: string`
- `data: Uint8Array`
- Constructors:
  - `image(data, mime)`
  - `json(value, mime?)`
  - `text(value, mime?)`

#### LanguageModelPromptTsxPart

- `value: unknown`
- Appears only inside tool results.

---

## OpenResponses Types

### ItemParam Union

- `ItemReferenceParam`
- `ReasoningItemParam`
- `UserMessageItemParam`
- `SystemMessageItemParam`
- `DeveloperMessageItemParam`
- `AssistantMessageItemParam`
- `FunctionCallItemParam`
- `FunctionCallOutputItemParam`

### Message Types

All message items have `type: "message"` and a role-specific `role`.

#### UserMessageItemParam

- `role: "user"`
- `content: string | (InputTextContentParam | InputImageContentParamAutoParam | InputFileContentParam)[]`

#### SystemMessageItemParam

- `role: "system"`
- `content: string | InputTextContentParam[]`

#### DeveloperMessageItemParam

- `role: "developer"`
- `content: string | InputTextContentParam[]`

#### AssistantMessageItemParam

- `role: "assistant"`
- `content: string | (OutputTextContentParam | RefusalContentParam)[]`

### Function Call Types

#### FunctionCallItemParam

- `type: "function_call"`
- `call_id: string`
- `name: string`
- `arguments: string` (JSON string)

#### FunctionCallOutputItemParam

- `type: "function_call_output"`
- `call_id: string`
- `output: string | (InputTextContentParam | InputImageContentParamAutoParam | InputFileContentParam | InputVideoContent)[]`

### Content Part Types (OpenResponses)

- Input:
  - `InputTextContentParam` → `{ type: "input_text", text }`
  - `InputImageContentParamAutoParam` → `{ type: "input_image", image_url, detail? }`
  - `InputFileContentParam` → `{ type: "input_file", filename?, file_data?, file_url? }`
  - `InputVideoContent` → `{ type: "input_video", video_url }` (only allowed in function call output)
- Output:
  - `OutputTextContentParam` → `{ type: "output_text", text, annotations? }`
  - `RefusalContentParam` → `{ type: "refusal", refusal }`

---

## Translation Mapping

### User Messages

**VS Code**: `LanguageModelChatMessage` with `role = User`  
**OpenResponses**: `UserMessageItemParam`

#### Content mapping

- If the VS Code content is a string:
  - Use `content: "..."` (string form), or wrap as `[{ type: "input_text", text }]`.
- For part arrays:
  - `LanguageModelTextPart.value` → `{ type: "input_text", text }`
  - `LanguageModelDataPart`:
    - `mimeType` starts with `image/` → `{ type: "input_image", image_url: "data:<mime>;base64,<data>" }`
    - `mimeType` starts with `text/` → `{ type: "input_text", text: decoded UTF-8 }`
    - `mimeType` is `application/json` → `{ type: "input_text", text: JSON string }` or `{ type: "input_file", file_data: base64 }`
    - other → `{ type: "input_file", file_data: base64 }`
- `LanguageModelToolResultPart` must be translated into **separate** `FunctionCallOutputItemParam` items (see Tool Results below). Preserve item order with surrounding user content.

### Assistant Messages

**VS Code**: `LanguageModelChatMessage` with `role = Assistant`  
**OpenResponses**: `AssistantMessageItemParam`

#### Content mapping

> ⚠️ **CRITICAL**: For INPUT messages, use **string content** or `input_text`, NOT `output_text`.
> The `output_text` type is only used in API responses, not requests.

- **Preferred**: Use plain string content:
  ```json
  { "type": "message", "role": "assistant", "content": "Response text here" }
  ```
- **Alternative**: Array with `input_text`:
  ```json
  {
    "type": "message",
    "role": "assistant",
    "content": [{ "type": "input_text", "text": "..." }]
  }
  ```
- **DO NOT USE** for input: `[{ type: "output_text", text }]` ❌

#### Tool call handling

> ⚠️ **CRITICAL**: `function_call` is NOT a valid input item type in the Vercel AI Gateway implementation.

- `LanguageModelToolCallPart` from conversation history **cannot** be translated to separate `FunctionCallItemParam` items
- **Workaround**: Embed tool call context in the assistant message text:
  ```json
  {
    "type": "message",
    "role": "assistant",
    "content": "I'll check the weather.\n\n[Tool Call: get_weather({\"location\": \"SF\"}) -> call_id: call_123]"
  }
  ```
- `LanguageModelDataPart` has **no direct assistant output equivalent**; encode into text or omit.

### Tool Calls

**VS Code**: `LanguageModelToolCallPart`  
**OpenResponses**: ~~`FunctionCallItemParam`~~ **NOT SUPPORTED AS INPUT**

> ⚠️ **CRITICAL**: The OpenAPI spec shows `FunctionCallItemParam` as part of the `ItemParam` union,
> but the actual Vercel AI Gateway implementation does NOT accept `function_call` as an input item.
> See [IMPLEMENTATION_CONSTRAINTS.md](../../../packages/openresponses-client/IMPLEMENTATION_CONSTRAINTS.md).

**Translation Strategy**:

- For NEW tool calls (in current response): The model returns them as `function_call` output items
- For HISTORY (past tool calls): Embed in assistant message text as context (see above)

### Tool Results

**VS Code**: `LanguageModelToolResultPart`  
**OpenResponses**: `FunctionCallOutputItemParam`

> ⚠️ **Note**: `function_call_output` items work, but the underlying LLM provider
> expects context about what function was called. Orphaned tool results may fail
> at the provider level.

Mapping:

- `call_id` ← `callId`
- `type` = `"function_call_output"`
- `output`: String containing the tool result (JSON or plain text)

Content translation for `output`:

- `LanguageModelTextPart.value` → include in output string
- `LanguageModelDataPart`:
  - text/\* → decoded UTF-8 text
  - application/json → JSON string
  - other → `[Binary data: <mimeType>]` placeholder
- Multiple parts → join with newlines

### Edge Cases and Notes

- VS Code has **no** `system` or `developer` message roles. Use `instructions` field for system prompts.
- VS Code `name` field has no OpenResponses equivalent; drop it.
- VS Code tool calls/results are **message content parts**, but OpenResponses treats tool results as **separate items**.
- **Tool calls in history**: Cannot be separate items; embed in assistant message text.
- OpenResponses supports assistant `refusal` content, which has no VS Code equivalent.
- OpenResponses supports input video only inside `function_call_output`.

---

## Quick Reference: Valid Input Items

| Item Type              | Valid as Input? | Notes                                      |
| ---------------------- | --------------- | ------------------------------------------ |
| `message` (user)       | ✅ Yes          | Use `input_text` for content               |
| `message` (assistant)  | ✅ Yes          | Use **string** or `input_text` content     |
| `message` (developer)  | ✅ Yes          | Use `input_text` for content               |
| `message` (system)     | ✅ Yes          | Prefer `instructions` field instead        |
| `function_call`        | ❌ **NO**       | Not in input schema!                       |
| `function_call_output` | ✅ Yes          | Needs context from prior assistant message |
