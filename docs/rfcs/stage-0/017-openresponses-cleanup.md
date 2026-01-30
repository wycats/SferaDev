# RFC 017: OpenResponses Cleanup and Logging Audit

**Status**: Stage 0 (Draft)  
**Created**: 2026-01-29  
**Author**: Agent

## Summary

Clean up the vscode-ai-gateway extension to remove dead code from the legacy Vercel AI SDK implementation and establish a coherent, principled logging strategy designed to enable efficient debugging of API issues like 400 errors.

## Background

The vscode-ai-gateway extension currently has **two parallel implementations**:

1. **Legacy Path** (Vercel AI SDK): Uses `@ai-sdk/gateway` + `streamText` from the `ai` package
2. **OpenResponses Path**: Uses `openresponses-client` package with direct SSE streaming

The OpenResponses implementation was added to get accurate token usage reporting (the legacy path always returns `outputTokens: 0`). It's gated behind `experimental.useOpenResponses` config flag (default: `false`).

### Current Issues

1. **Dual Code Paths**: Maintenance burden and confusion
2. **Inconsistent Logging**: Mix of `logger.debug`, `logger.trace`, `logger.info` without clear principles
3. **Debugging Friction**: When 400 errors occur, logs don't clearly show the request/response cycle
4. **Dead Code**: Legacy Vercel AI SDK code is unused when OpenResponses is enabled

## Proposal

### Phase 1: Make OpenResponses the Default

1. **Change `experimental.useOpenResponses` default to `true`**
2. **Deprecate the setting** (log warning if explicitly set to `false`)
3. **Keep legacy code for one release cycle** (with deprecation warnings)

### Phase 2: Remove Legacy Code

After one release cycle with OpenResponses as default:

1. **Remove from `provider.ts`**:
   - Import of `@ai-sdk/gateway`, `streamText`, `jsonSchema`, `TextStreamPart`, `ToolSet` from `ai`
   - `StreamChunk` type alias
   - `SILENTLY_IGNORED_CHUNK_TYPES` set
   - `handleStreamChunk()` method and all `handle*Chunk()` helper methods
   - `handleToolCall()`, `handleToolCallStreamingStart()`, `handleToolCallDelta()`, `flushToolCallBuffer()` methods
   - `toolCallBuffer` property
   - `convertMessages()`, `convertSingleMessage()`, `createMultiModalMessage()`, `isTextPart()`, `extractToolResultTexts()`, `isValidMessage()`, `fixSystemMessages()` functions

2. **Remove package dependencies**:
   - `@ai-sdk/gateway`
   - `ai` package (streamText, etc.)

3. **Consolidate to single flow**:
   - `provideLanguageModelChatResponse()` → directly call `executeOpenResponsesChat()`
   - Remove the config check branch

### Phase 3: Logging Audit

Establish a **principled logging strategy**:

#### Log Levels

| Level   | Purpose                 | When to Use                                                             |
| ------- | ----------------------- | ----------------------------------------------------------------------- |
| `error` | Actionable failures     | API errors, authentication failures, unrecoverable states               |
| `warn`  | Degraded but functional | Token limits approaching, fallbacks activated, deprecated features used |
| `info`  | Major lifecycle events  | Request started/completed, model loaded, extension activated            |
| `debug` | Implementation details  | Token estimates, cache hits/misses, config values, response metadata    |
| `trace` | Wire-level details      | Raw request bodies, raw response events, byte-level data                |

#### Structured Logging for API Calls

For every API call, log:

1. **Before request** (`debug`): Model ID, message count, tool count, estimated tokens
2. **Request body** (`trace`): Full JSON request body (sanitized of secrets)
3. **Response events** (`trace`): Each SSE event type and summary
4. **Completion** (`info`): Success/failure, token usage, response ID, finish reason
5. **Errors** (`error`): Full error details with request context

#### Prefix Convention

All OpenResponses logs should use `[OpenResponses]` prefix for easy filtering:

```typescript
logger.debug(`[OpenResponses] Starting request to ${model.id}`);
logger.trace(`[OpenResponses] Request body: ${JSON.stringify(body)}`);
logger.info(
  `[OpenResponses] Completed: ${usage.input_tokens} in, ${usage.output_tokens} out`,
);
logger.error(`[OpenResponses] Failed: ${error.message} (${error.code})`);
```

#### Request Context Logging

For debugging 400 errors, ensure these are always logged at `debug` level:

- Number of messages by role (user/assistant/developer)
- Number of function_call and function_call_output items
- Content types in each message (input_text, input_image, output_text, etc.)
- Tool count and names

### Files to Modify

| File                                 | Changes                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `src/config.ts`                      | Change default for `experimental.useOpenResponses` to `true`, add deprecation |
| `src/provider.ts`                    | Remove legacy code path, simplify to direct OpenResponses call                |
| `src/provider.test.ts`               | Remove tests for legacy stream handling                                       |
| `src/provider/openresponses-chat.ts` | Enhance logging per strategy                                                  |
| `src/provider/stream-adapter.ts`     | Enhance logging per strategy                                                  |
| `package.json`                       | Remove `@ai-sdk/gateway`, `ai` dependencies (Phase 2)                         |

### Files to Keep

These are **NOT dead code** and should be kept:

| File                                | Reason                                                      |
| ----------------------------------- | ----------------------------------------------------------- |
| `src/models.ts`                     | Model fetching (used by both paths)                         |
| `src/models/`                       | Model filtering, enrichment, identity parsing               |
| `src/tokens/`                       | Token counting and caching (used for pre-flight validation) |
| `src/status-bar.ts`                 | Token usage display                                         |
| `src/auth.ts`, `src/vercel-auth.ts` | Authentication (used by both paths)                         |
| `src/logger.ts`                     | Logging infrastructure                                      |
| `src/config.ts`                     | Configuration (keep, just update defaults)                  |

## Implementation Plan

### Immediate (This Session)

1. ✅ Commit current checkpoint
2. Create this RFC
3. **Debug the current 400 error** by adding targeted logging
4. Fix the root cause

### Short Term (Next PR)

1. Add comprehensive request/response logging to `openresponses-chat.ts`
2. Add structured logging for API call context
3. Change `experimental.useOpenResponses` default to `true`

### Medium Term (Following PR)

1. Remove legacy Vercel AI SDK code path
2. Remove unused imports and dependencies
3. Simplify `provider.ts` structure

## Current 400 Error Investigation

Based on logs, the 400 error is `input: Invalid input`. Previous fixes:

- Mapped unknown roles to `"developer"` instead of `"system"`
- Removed `"system"` case from `createMessageItem()`

**Next debugging steps**:

1. Add logging of the full translated `input` array structure
2. Log each item's type, role, and content types
3. Check for any remaining invalid structures

### Suspected Issues

1. **Empty content arrays** - Might be sending `content: []`
2. **Mixed content types** - `output_text` in user messages or `input_text` in assistant messages
3. **Invalid function_call/output structure** - Missing required fields
4. **Null/undefined values** - JSON serialization issues

## Success Criteria

1. **No 400 errors** for valid requests
2. **Clear logging** that makes debugging future issues trivial
3. **Single code path** (OpenResponses only)
4. **Reduced bundle size** (no Vercel AI SDK dependencies)
5. **Accurate token usage** reported for all completions
