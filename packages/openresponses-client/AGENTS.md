# Agent Instructions for openresponses-client

This package implements the **OpenResponses wire protocol** for communicating with LLM APIs.

## ⚠️ CRITICAL: Do Not Confuse APIs

### OpenResponses is NOT:

1. **OpenAI Chat Completions API** (`/v1/chat/completions`) - Different endpoint, different schema
2. **Vercel AI SDK format** - That's a client library abstraction, not a wire protocol
3. **Any other "OpenAI-compatible" API** - OpenResponses has its own distinct schema

### When working on this package:

- **DO** refer to [docs/OPENRESPONSES-SPEC.md](./docs/OPENRESPONSES-SPEC.md)
- **DO** use the [openapi.json](./openapi.json) spec as source of truth
- **DO** use the generated types in `src/generated/`
- **DO NOT** reference OpenAI documentation for format details
- **DO NOT** reference Vercel AI SDK documentation for wire protocol

## Documentation

| Resource                   | Location                                                   |
| -------------------------- | ---------------------------------------------------------- |
| OpenResponses Spec Summary | [docs/OPENRESPONSES-SPEC.md](./docs/OPENRESPONSES-SPEC.md) |
| OpenAPI Specification      | [openapi.json](./openapi.json)                             |
| Generated Types            | [src/generated/types/](./src/generated/types/)             |
| Client Implementation      | [src/client.ts](./src/client.ts)                           |
| Official Reference         | https://www.openresponses.org/reference                    |

## Key Schema Differences from Chat Completions

### Messages

**Chat Completions (WRONG for this package):**

```json
{ "role": "user", "content": "Hello" }
```

**OpenResponses (CORRECT):**

```json
{
  "type": "message",
  "role": "user",
  "content": [{ "type": "input_text", "text": "Hello" }]
}
```

### Content Types

- User/System/Developer roles use `input_text`, `input_image`, `input_file`
- Assistant role uses `output_text`, `refusal`
- Mixing these up causes 400 errors!

### Tools

**Chat Completions (WRONG for this package):**

```json
{
  "type": "function",
  "function": {
    "name": "get_weather",
    "parameters": {...}
  }
}
```

**OpenResponses (CORRECT - flat structure):**

```json
{
  "type": "function",
  "name": "get_weather",
  "parameters": {...}
}
```

## Type Generation

Types are generated from the OpenAPI spec using Kubb:

```bash
pnpm generate  # Regenerates types from openapi.json
```

The Kubb config uses `discriminator: "inherit"` to properly handle union types.

## Debugging API Errors

If you get HTTP 400 "Invalid input":

1. Check the trace logs for the exact request body
2. Verify `type` discriminators are correct on all items
3. Verify content types match roles (`input_text` for user, `output_text` for assistant)
4. Validate against [openapi.json](./openapi.json)

## External References

- **OpenResponses Website**: https://www.openresponses.org
- **OpenResponses Spec**: https://www.openresponses.org/specification
- **OpenResponses Reference**: https://www.openresponses.org/reference
- **OpenAPI JSON**: https://www.openresponses.org/openapi/openapi.json
- **GitHub**: https://github.com/openresponses/openresponses
