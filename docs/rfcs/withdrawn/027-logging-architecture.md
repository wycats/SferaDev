---
title: Logging Architecture
stage: 0
feature: logging
exo:
  tool: exo rfc create
  protocol: 1
---

# RFC 027: Logging Architecture

**Status:** Stage 0 (Draft)  
**Created:** 2026-01-31  
**Related:** RFC 015 (Logging Infrastructure Improvements), RFC 00020 (Hierarchical Logging Architecture)

## Summary

Define a comprehensive logging architecture for the VS Code AI Gateway extension that combines:

- Trace-level logging for high-frequency operations
- Structured logging with correlation IDs
- Hierarchical, session-scoped log directories
- Request-level artifact capture for replay
- JSONL indexes for cross-session and per-session queries

This RFC consolidates operational logging improvements with a structured, replay-ready logging filesystem layout.

## Motivation

### Current Gaps

1. **No trace level** for ultra-verbose operations.
2. **Scattered console usage** bypassing the logger.
3. **Silent critical operations** with no diagnostics.
4. **No request correlation** across async boundaries.
5. **Flat log files** with no session isolation or replay artifacts.

### Problems This Solves

- Faster incident debugging in production.
- Correlating activity across async operations.
- Replay of real requests for diagnosis.
- Cross-session analysis with structured indexes.

## Goals

1. Provide consistent logging levels including `trace`.
2. Enable structured logs for machine parsing when needed.
3. Create session-scoped log directories and indexes.
4. Capture request artifacts for replay.
5. Maintain backward compatibility with existing logs.

## Architecture Overview

### Directory Structure

```
{logDirectory}/
  sessions.jsonl                          # Index: all sessions
  errors.jsonl                            # Index: all errors (cross-session)

  {sessionId}/
    session.json                          # Session metadata
    requests.jsonl                        # Index: all requests in session
    gateway.log                           # Traditional rotating log (session-scoped)
    errors.log                            # Error-level only (session-scoped)

    requests/
      {chatId}/
        request.json                      # Full request body
        response.json                     # Response metadata + summary
        events.jsonl                      # Raw SSE events (TRACE level only)
```

### Session ID Format

```
{shortSessionId}-{date}
```

- `shortSessionId`: first 8 characters of `vscode.env.sessionId`
- `date`: ISO date (`YYYY-MM-DD`)

## Logging Levels

Extend the logger with a `trace` level above `debug`:

```typescript
const LOG_LEVELS = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};
```

## Structured Logging

Optional structured output:

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

## Correlation IDs

Generate per-request IDs to correlate logs:

```typescript
class RequestContext {
  private static counter = 0;
  static generate(): string {
    return `req-${Date.now()}-${++this.counter}`;
  }
}
```

## Request-Level Artifact Capture

For each chat request:

- `request.json`: Full request body
- `response.json`: Summary metadata, timings, and usage
- `events.jsonl`: Raw SSE events (TRACE-only)
- Index entry appended to `{sessionId}/requests.jsonl`
- Errors appended to root `errors.jsonl`

## Configuration

```jsonc
{
  "vercelAI.logging.fileDirectory": "~/.vscode-ai-gateway/logs",
  "vercelAI.logging.captureRequests": true,
  "vercelAI.logging.captureEvents": false,
  "vercelAIGateway.logLevel": "info",
  "vercelAIGateway.logFormat": "text",
}
```

Defaults:

- `captureRequests`: true when `fileDirectory` is set
- `captureEvents`: false (opt-in, verbose)

## Implementation Phases

### Phase 1: Foundation

1. Add `trace` level to `Logger` and schema.
2. Replace `console.*` with `logger.*`.
3. Add session context to logger and create directories.
4. Append `sessions.jsonl` and write `session.json`.

### Phase 2: Request Capture

5. Create per-request directory.
6. Write `request.json` before API call.
7. Write `response.json` on completion.
8. Append to `{sessionId}/requests.jsonl` and `errors.jsonl`.

### Phase 3: Event Capture (TRACE)

9. If log level is TRACE and `captureEvents` true, write `events.jsonl`.

## Query Patterns

- Latest session path:
  - `tail -1 .logs/sessions.jsonl | jq -r .path`
- All requests in current session:
  - `cat .logs/$(tail -1 .logs/sessions.jsonl | jq -r .path)/requests.jsonl`
- Requests with no tool calls:
  - `jq 'select(.toolCallsEmitted == 0 and .finishReason == "stop")' .logs/*/requests.jsonl`
- Replay a request:
  - `cat .logs/{sessionId}/requests/{chatId}/request.json | node scripts/test-openresponses.ts -`

## Backward Compatibility

- Flat log files remain valid.
- New structure created only when `fileDirectory` is set.
- Gradual migration with feature flag support.

## Alternatives Considered

- Single JSONL per session: rejected (hard to replay, large files).
- SQLite database: rejected (dependency, portability).
- Directory-only without indexes: rejected (no cross-session query).

## Open Questions

1. Should structured logging be default in development builds?
2. Should request IDs be exposed in user-facing error messages?
3. Should log rotation/cleanup be automated?

## References

- RFC 015: Logging Infrastructure Improvements
- RFC 00020: Hierarchical Logging Architecture
- [JSONL specification](https://jsonlines.org/)
- [VS Code OutputChannel API](https://code.visualstudio.com/api/references/vscode-api#OutputChannel)
