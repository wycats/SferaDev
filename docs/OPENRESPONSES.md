# OpenResponses API Reference

This document provides quick access to OpenResponses documentation for agents working on this codebase.

## ⚠️ CRITICAL: API Format Disambiguation

**OpenResponses is NOT:**

- OpenAI Chat Completions API (`/v1/chat/completions`)
- Vercel AI SDK format (that's a client library, not a wire protocol)
- Any other "OpenAI-compatible" API

**When working with OpenResponses code:**

- ✅ DO refer to the local documentation and OpenAPI spec
- ❌ DO NOT reference OpenAI or Vercel AI SDK documentation

## Quick Links

### Local Documentation

| Resource                    | Path                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| OpenResponses Spec Summary  | [packages/openresponses-client/docs/OPENRESPONSES-SPEC.md](../packages/openresponses-client/docs/OPENRESPONSES-SPEC.md) |
| OpenAPI Specification       | [packages/openresponses-client/openapi.json](../packages/openresponses-client/openapi.json)                             |
| Client Package README       | [packages/openresponses-client/README.md](../packages/openresponses-client/README.md)                                   |
| Client AGENTS.md            | [packages/openresponses-client/AGENTS.md](../packages/openresponses-client/AGENTS.md)                                   |
| VS Code Extension AGENTS.md | [packages/vscode-ai-gateway/AGENTS.md](../packages/vscode-ai-gateway/AGENTS.md)                                                 |

### External Documentation

| Resource                    | URL                                                |
| --------------------------- | -------------------------------------------------- |
| OpenResponses Website       | https://www.openresponses.org                      |
| OpenResponses Specification | https://www.openresponses.org/specification        |
| OpenResponses API Reference | https://www.openresponses.org/reference            |
| OpenAPI JSON (upstream)     | https://www.openresponses.org/openapi/openapi.json |
| GitHub Repository           | https://github.com/openresponses/openresponses     |

## Key Concepts

### Message Structure

```typescript
{
  type: "message",           // Discriminator (required)
  role: "user" | "assistant" | "system" | "developer",
  content: ContentPart[]     // Array of typed content parts
}
```

### Content Types

| Role                    | Content Type                              |
| ----------------------- | ----------------------------------------- |
| user, system, developer | `input_text`, `input_image`, `input_file` |
| assistant               | `output_text`, `refusal`                  |

### Tool Format (FLAT, not nested)

```typescript
{
  type: "function",
  name: "function_name",
  description: "...",
  parameters: { /* JSON Schema */ }
}
```

## Packages Using OpenResponses

- **openresponses-client** (`packages/openresponses-client/`) - TypeScript client for the API
- **vscode-ai-gateway** (`packages/vscode-ai-gateway/`) - VS Code extension using the client
