# Agent Context

This file contains important context for AI agents working on this codebase.

## ⚠️ CRITICAL: What This Project Is NOT

Before researching or making changes, understand these distinctions:

| We ARE using                                 | We are NOT using        |
| -------------------------------------------- | ----------------------- |
| **OpenResponses** (openresponses.org)        | OpenAI's Responses API  |
| **Vercel AI Gateway** (ai-gateway.vercel.sh) | Vercel AI SDK           |
| **VS Code Language Model API**               | OpenAI Chat Completions |

**OpenResponses** is an **open specification** for LLM APIs. It is NOT OpenAI.

- Canonical docs: https://www.openresponses.org/
- Vercel AI Gateway docs: https://vercel.com/docs/ai-gateway/sdks-and-apis/openresponses
- Our endpoint: `https://ai-gateway.vercel.sh/v1/responses`

Do NOT fetch OpenAI documentation when debugging OpenResponses issues. The APIs have similar concepts but different schemas.

## Key Documentation References

### OpenResponses API Specification (PRIMARY SOURCE)

- **Canonical docs**: https://www.openresponses.org/
- **Vercel implementation**: https://vercel.com/docs/ai-gateway/sdks-and-apis/openresponses
- **Local OpenAPI spec**: [packages/openresponses-client/openapi.json](packages/openresponses-client/openapi.json)
- **⚠️ Implementation Constraints**: [packages/openresponses-client/IMPLEMENTATION_CONSTRAINTS.md](packages/openresponses-client/IMPLEMENTATION_CONSTRAINTS.md) - CRITICAL: Documents behaviors that differ from the OpenAPI spec
- **Generated Zod schemas**: [packages/openresponses-client/src/generated/schemas.ts](packages/openresponses-client/src/generated/schemas.ts)
- **Client README**: [packages/openresponses-client/README.md](packages/openresponses-client/README.md) - includes message format examples
- **Key schemas**:
  - `CreateResponseBody` - Request body for creating a response
  - `ItemParam` - Union of all input item types (but see IMPLEMENTATION_CONSTRAINTS.md - `function_call` is NOT valid input!)
  - `UserMessageItemParam`, `AssistantMessageItemParam`, `DeveloperMessageItemParam`, etc.

### VS Code Language Model API Types

- **Location**: [docs/research/language-model-types.d.ts](docs/research/language-model-types.d.ts)
- **Description**: Extracted TypeScript type definitions for VS Code's Language Model API
- **Source**: https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.d.ts
- **Key types**:
  - `LanguageModelChatMessageRole` (enum: User=1, Assistant=2)
  - `LanguageModelChatMessage` (class with role, content, name)
  - `LanguageModelTextPart`, `LanguageModelDataPart`, `LanguageModelToolCallPart`, `LanguageModelToolResultPart`

### Full VS Code API (reference only)

- **Location**: [docs/research/vscode.d.ts](docs/research/vscode.d.ts)
- **Description**: Complete VS Code extension API type definitions

## Project Structure

- `apps/vscode-ai-gateway/` - VS Code extension that proxies to OpenResponses API
- `packages/openresponses-client/` - TypeScript client for OpenResponses API

## Current Work

### Message Translation (apps/vscode-ai-gateway)

The extension translates VS Code Language Model API messages to OpenResponses format.
See [docs/research/message-translation-mapping.md](docs/research/message-translation-mapping.md) for the canonical mapping.
