# Agent Instructions for vscode-ai-gateway

This VS Code extension provides AI models via the Vercel AI Gateway using the OpenResponses wire protocol.

## ⚠️ CRITICAL: System Prompt Extraction

**DO NOT REMOVE `extractSystemPrompt()` from openresponses-chat.ts!**

VS Code Copilot uses the **proposed System role** (role=3) to send system prompts.
See: `vscode.proposed.languageModelSystem.d.ts`

Without this extraction:

- The system prompt gets translated as a regular message
- Claude sees incorrect conversation structure
- Tool calling breaks

The function also handles **legacy fallback** for older VS Code versions that
may send system prompts as Assistant messages (role=2).

## ⚠️ CRITICAL: API Format Disambiguation

### The OpenResponses API is NOT:

1. **OpenAI Chat Completions API** (`/v1/chat/completions`)
   - Different endpoint (`/v1/responses`)
   - Different request/response schema
   - Different content type discriminators

2. **Vercel AI SDK format**
   - The SDK is a _client library_ that abstracts over APIs
   - OpenResponses is the _wire protocol_ sent over HTTP
   - SDK examples show client-side code, not raw API format

3. **"OpenAI-compatible" APIs**
   - OpenResponses has its own distinct schema
   - Just because it has similar concepts doesn't mean the format is the same

### When debugging or modifying this extension:

- **DO** refer to the [OpenResponses specification](../../packages/openresponses-client/docs/OPENRESPONSES-SPEC.md)
- **DO** use the [OpenAPI schema](../../packages/openresponses-client/openapi.json) as source of truth
- **DO** use types from `openresponses-client` package
- **DO NOT** look at OpenAI documentation for format details
- **DO NOT** look at Vercel AI SDK documentation for wire protocol

## Key Files

| File                                   | Purpose                                    |
| -------------------------------------- | ------------------------------------------ |
| `src/provider/openresponses-chat.ts`   | OpenResponses API integration              |
| `src/provider/stream-adapter.ts`       | Converts streaming events to VS Code parts |
| `src/provider/usage-tracker.ts`        | Tracks token usage                         |
| `../../packages/openresponses-client/` | Generated types and client                 |

## OpenResponses Message Format

### Content Type Rules

| VS Code Role  | OpenResponses Role | Content Type  |
| ------------- | ------------------ | ------------- |
| User (1)      | `user`             | `input_text`  |
| Assistant (2) | `assistant`        | `output_text` |
| Unknown       | `user`             | `input_text`  |

**Mixing up `input_text` vs `output_text` causes HTTP 400 errors!**

### Message Structure

```typescript
// User message
{
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "Hello" }]
}

// Assistant message
{
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: "Hi there!" }]
}
```

### Tool Format (FLAT structure)

```typescript
// CORRECT for OpenResponses
{
  type: "function",
  name: "get_weather",
  description: "Get weather",
  parameters: { type: "object", properties: {...} }
}

// WRONG (OpenAI Chat Completions format - nested)
{
  type: "function",
  function: {  // <-- NO! Don't nest under "function"
    name: "get_weather",
    ...
  }
}
```

## Debugging HTTP 400 Errors

1. Enable trace logging: Set `vercelAiGateway.logging.level` to `"trace"`
2. Check the Output panel for "Vercel AI Gateway" logs
3. Look for the full request body in trace logs
4. Verify:
   - All items have correct `type` discriminator
   - User content uses `input_text`, Assistant uses `output_text`
   - Tools use flat structure (not nested)
   - Required fields are present

## Documentation Links

### Internal

- [OpenResponses Spec Summary](../../packages/openresponses-client/docs/OPENRESPONSES-SPEC.md)
- [OpenAPI Schema](../../packages/openresponses-client/openapi.json)
- [Client Package](../../packages/openresponses-client/README.md)

### External

- **OpenResponses Website**: https://www.openresponses.org
- **OpenResponses Reference**: https://www.openresponses.org/reference
- **OpenResponses Specification**: https://www.openresponses.org/specification
- **OpenAPI JSON**: https://www.openresponses.org/openapi/openapi.json

### NOT Relevant (Do Not Use)

- ❌ OpenAI Chat Completions documentation
- ❌ OpenAI Responses API documentation (it's similar but not identical)
- ❌ Vercel AI SDK `streamText`/`generateText` examples (that's SDK format, not wire format)
