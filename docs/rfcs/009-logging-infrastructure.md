# RFC 009: Logging Infrastructure Improvements

**Status**: Stage 0 (Draft)  
**Created**: 2026-01-28  
**Author**: Logging Improvements Initiative

## Summary

Enhance the VS Code AI Gateway extension's logging infrastructure to provide better observability, debugging capabilities, and production diagnostics. This includes adding a trace level, consolidating scattered console.\* calls, implementing structured logging, and adding strategic log points throughout the codebase.

## Motivation

### Current State

The extension has a configurable `Logger` class in [logger.ts](../../apps/vscode-ai-gateway/src/logger.ts) with the following characteristics:

**Strengths:**

- Clean level hierarchy: `off`, `error`, `warn`, `info`, `debug`
- Hot config reload via `ConfigService.onDidChange` subscription
- Proper VS Code output channel integration
- Singleton pattern prevents duplicate channels

**Gaps Identified:**

1. **No Trace Level**: Debug is the most verbose level, but high-frequency operations (token estimation loops, individual tool calls) need an even more granular level to avoid flooding debug logs.

2. **Scattered Console Usage**: Several files bypass the logger entirely:
   - [provider.ts](../../apps/vscode-ai-gateway/src/provider.ts): `console.error` for error handling
   - [auth.ts](../../apps/vscode-ai-gateway/src/auth.ts): `console.log` for authentication debugging
   - These calls don't respect the configured log level

3. **Silent Operations**: Critical operations have no logging at all:
   - [models.ts](../../apps/vscode-ai-gateway/src/models.ts): No logs for API calls, response handling, or errors
   - [enrichment.ts](../../apps/vscode-ai-gateway/src/models/enrichment.ts): No logs for cache hits/misses, enrichment timing

4. **No Structured Logging**: Logs are plain strings, making automated parsing and analysis difficult.

5. **No Correlation**: No request IDs or correlation tokens to trace operations across async boundaries.

### Problems This Solves

1. **Production Debugging**: Users can enable trace logging temporarily to diagnose issues without rebuilding.

2. **Support Escalation**: Structured logs can be exported and shared for support analysis.

3. **Performance Analysis**: Timing logs for API calls and enrichment help identify bottlenecks.

4. **Operation Tracing**: Correlation IDs allow following a request through the entire flow.

## Detailed Design

### 1. Add Trace Level

Extend the log level hierarchy:

```typescript
const LOG_LEVELS = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5, // NEW
};
```

Update configuration schema in `package.json`:

```json
{
  "vercelAIGateway.logLevel": {
    "type": "string",
    "enum": ["off", "error", "warn", "info", "debug", "trace"],
    "default": "info",
    "description": "Controls the verbosity of logging"
  }
}
```

Add trace method to Logger:

```typescript
trace(message: string, ...args: unknown[]) {
  this.log('trace', message, ...args);
}
```

### 2. Convert Console Calls to Logger

Replace all `console.*` calls with appropriate logger methods:

| File        | Current              | Replacement                                |
| ----------- | -------------------- | ------------------------------------------ |
| provider.ts | `console.error(...)` | `logger.error(...)`                        |
| auth.ts     | `console.log(...)`   | `logger.debug(...)` or `logger.trace(...)` |

### 3. Add Strategic Log Points

**P0 - Critical Path Logging** (info level):

- Model list fetch start/complete with timing
- Authentication flow state changes
- Configuration changes

**P1 - Diagnostic Logging** (debug level):

- Enrichment cache hits/misses
- Token estimation results
- Tool call routing decisions
- Streaming chunk counts

**P2 - Trace Logging** (trace level):

- Individual tool call details
- Token estimation per-chunk calculations
- Cache key generation
- Event emission details

### 4. Structured Logging (Optional Enhancement)

Add optional structured log format for machine parsing:

```typescript
interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  context?: {
    requestId?: string;
    modelId?: string;
    operation?: string;
    durationMs?: number;
    [key: string]: unknown;
  };
}
```

Configuration option:

```json
{
  "vercelAIGateway.logFormat": {
    "type": "string",
    "enum": ["text", "json"],
    "default": "text",
    "description": "Log output format"
  }
}
```

### 5. Request Correlation

Generate and propagate request IDs for tracing:

```typescript
class RequestContext {
  private static counter = 0;

  static generate(): string {
    return `req-${Date.now()}-${++this.counter}`;
  }
}

// Usage in provider.ts
async provideLanguageModelChatResponse(messages, options, token) {
  const requestId = RequestContext.generate();
  logger.info(`[${requestId}] Starting chat response`, { modelId: options.modelId });
  // ... rest of implementation
  logger.info(`[${requestId}] Chat response complete`, { durationMs });
}
```

## Implementation Plan

### Phase 1: Foundation (P0)

1. Add trace level to Logger class
2. Update package.json configuration schema
3. Convert console.\* calls in provider.ts and auth.ts
4. Add basic timing logs to ModelsClient

**Estimated effort**: 2-3 hours

### Phase 2: Diagnostic Coverage (P1)

1. Add logging to ModelEnricher (cache hits, enrichment timing)
2. Add logging to token estimation
3. Add logging to tool call handling
4. Add logging to ConfigService changes

**Estimated effort**: 2-3 hours

### Phase 3: Advanced Features (P2/P3)

1. Implement request correlation
2. Add structured logging option
3. Add trace-level logging for high-frequency operations

**Estimated effort**: 3-4 hours

## Testing Strategy

1. **Unit Tests**: Verify log level filtering, structured output format
2. **Integration Tests**: Verify logs appear in output channel with correct levels
3. **Manual Testing**: Enable each log level and verify expected output

## Configuration

New/updated configuration options:

| Setting                     | Type | Default | Description                                     |
| --------------------------- | ---- | ------- | ----------------------------------------------- |
| `vercelAIGateway.logLevel`  | enum | `info`  | Log verbosity (off/error/warn/info/debug/trace) |
| `vercelAIGateway.logFormat` | enum | `text`  | Output format (text/json)                       |

## Backward Compatibility

- Default log level remains `info`
- Existing behavior unchanged for users who don't modify settings
- No breaking changes to public API

## Alternatives Considered

### 1. External Logging Library

Could use winston, pino, or similar. Rejected because:

- Adds dependency weight to extension
- VS Code output channel has specific constraints
- Current Logger is sufficient with enhancements

### 2. VS Code Diagnostic API

Could use `vscode.DiagnosticCollection`. Rejected because:

- Designed for code problems, not operational logs
- Doesn't fit our use case

## Open Questions

1. Should structured logging be enabled by default in development builds?
2. Should request IDs be visible to users in error messages?
3. Should we add log rotation/truncation for the output channel?

## References

- [VS Code Output Channel API](https://code.visualstudio.com/api/references/vscode-api#OutputChannel)
- [RFC 008: High-Fidelity Model Mapping](./008-high-fidelity-model-mapping.md)
- [RFC 008a: Enrichment-Based Capability Refinement](./008a-enrichment-capability-refinement.md)
