---
title: Hierarchical Logging Architecture# RFC 019: Hierarchical Logging Architecture
stage: 0
feature: Unknown
exo:
    tool: exo rfc create
    protocol: 1
---

# RFC 00020: Hierarchical Logging Architecture# RFC 019: Hierarchical Logging Architecture

- [VS Code Extension API: env](https://code.visualstudio.com/api/references/vscode-api#env)- [JSONL specification](https://jsonlines.org/)- [RFC 015: Logging Infrastructure](015-logging-infrastructure.md) (if exists)## References**Rejected:** Indexes enable fast cross-session queries without traversing directories.### No indexes, just directory structure**Rejected:** Adds dependency; JSONL is more portable and grep-friendly.### SQLite database**Rejected:** Harder to extract individual requests for replay; file grows unbounded.### Single JSONL file per session## Alternatives Considered3. Document migration path for users with existing log analysis scripts2. Enable by default once stable1. Implement behind feature flag initially### Rollout- No breaking changes to configuration- New structure created alongside if `fileDirectory` is set- Existing flat log files continue to work### Backward Compatibility## MigrationThese are tracked separately and can build on this foundation.4. **Structured log format** — JSON-based gateway.log (vs plain text)3. **Log aggregation UI** — VS Code webview for browsing logs2. **Automatic cleanup/rotation** — Pruning old sessions1. **Suspicious stop detection** — Heuristic-based flagging of premature stops### Out of Scope for This RFC## Future Work| `replay-path {path}` | Replay from specific `request.json` path || `replay-session {sessionId}` | List requests in session, pick one || `replay-latest` | Replay latest request from current session || `replay` | Replay from `api-errors.log` (legacy) ||---------|----------|| Command | Behavior |Update `test-openresponses.ts` commands:## Test Script Integration`jq 'select(.inputTokens > 100000)' .logs/*/requests.jsonl`bash### Find high-token requests`cat .logs/{sessionId}/requests/{chatId}/request.json | node scripts/test-openresponses.ts -`bash### Replay a specific request`cat .logs/errors.jsonl`bash### Find all errors`jq 'select(.toolCallsEmitted == 0 and .finishReason == "stop")' .logs/*/requests.jsonl`bash### Find requests with no tool calls`cat .logs/$(tail -1 .logs/sessions.jsonl | jq -r .path)/requests.jsonl`bash### Find all requests in current session`tail -1 .logs/sessions.jsonl | jq -r .path`bash### Find latest session## Query Patterns- `captureEvents`: `false` (opt-in, verbose)- `captureRequests`: `true` when `fileDirectory` is setDefault behavior:`}  "vercelAI.logging.captureEvents": false    // Enable events.jsonl (requires TRACE)  "vercelAI.logging.captureRequests": true,  // Enable request.json capture  "vercelAI.logging.fileDirectory": "~/.vscode-ai-gateway/logs",{`jsoncNew settings:### Configuration - Each event as single JSONL line with sequence number - When log level is TRACE, write `events.jsonl`8. **Optional SSE event logging**### Phase 3: Event Capture (TRACE only) - Update root `errors.jsonl` for cross-session visibility7. **Append to error index on failure** - Update `{sessionId}/requests.jsonl` with summary6. **Append to request index** - Include timing, tokens, summary - Write `response.json` after completion5. **Capture response metadata** - Write `request.json` before API call - Generate path: `{sessionId}/requests/{chatId}/`4. **Create request directory on each chat**### Phase 2: Request-Level Capture - Update `errors.log` path to `{sessionId}/errors.log` - Update `gateway.log` path to `{sessionId}/gateway.log`3. **Migrate file logging to session directory** - Write `session.json` with metadata - Append to `sessions.jsonl` on activation2. **Session index management** - Create session directory structure - Initialize from `vscode.env.sessionId` at activation - Store `sessionId` in `ExtensionLogger`1. **Add session context to logger**### Phase 1: Core Infrastructure## Implementation`{"seq":3,"type":"response.output_text.delta","timestamp":"...","data":{...}}{"seq":2,"type":"response.output_item.added","timestamp":"...","data":{...}}{"seq":1,"type":"response.created","timestamp":"...","data":{...}}`jsoncRaw SSE events for deep debugging:#### `events.jsonl` (TRACE only)`}  }    "eventCount": 156    "toolCallsEmitted": 3,    "textParts": 12,  "summary": {  },    "durationMs": 5200    "completedAt": "2026-01-30T17:45:05.200Z",    "startedAt": "2026-01-30T17:45:00.000Z",  "timing": {  },    "output_tokens": 500    "input_tokens": 80000,  "usage": {  "finishReason": "stop",  "model": "anthropic/claude-opus-4.5",  "responseId": "gen_01KG...",{`jsoncResponse metadata (not full output, which can be large):#### `response.json````}  "instructions": "..."  "max_output_tokens": 4096,  "temperature": 0.7,  "tool_choice": "auto",  "tools": [...],  "input": [...],  "model": "anthropic/claude-opus-4.5",{```jsoncFull `CreateResponseBody`as sent to OpenResponses API:####`request.json`### Request Artifacts```}  "path": "a1b2c3d4-2026-01-30/requests/def67890-1706000100/"  "tokenInfo": { "actual": 250000, "max": 200000 },  "errorCode": "invalid_request_body",  "error": "input too long",  "timestamp": "2026-01-30T17:46:40.000Z",  "chatId": "def67890-1706000100",  "sessionId": "a1b2c3d4-2026-01-30",{```jsonc#### `errors.jsonl`(root)```}  "path": "requests/abc12345-1706000000/"  "error": null,  "durationMs": 5200,  "textParts": 12,  "toolCallsEmitted": 3,  "toolsSent": 45,  "finishReason": "stop",  "outputTokens": 500,  "inputTokens": 80000,  "model": "anthropic/claude-opus-4.5",  "timestamp": "2026-01-30T17:45:00.000Z",  "responseId": "gen_01KG...",  "chatId": "abc12345-1706000000",{```jsonc####`{sessionId}/requests.jsonl``}  "path": "a1b2c3d4-2026-01-30/"  "machineId": "...",  // Optional, for cross-machine correlation  "extensionVersion": "0.2.3",  "vscodeVersion": "1.96.0",  "startedAt": "2026-01-30T17:00:00.000Z",  "sessionId": "a1b2c3d4-2026-01-30",{`jsonc#### `sessions.jsonl`### Index SchemasExample: `a1b2c3d4-2026-01-30`- `date` = ISO date (YYYY-MM-DD)- `shortSessionId` = first 8 characters of `vscode.env.sessionId`Where:`{shortSessionId}-{date}`### Session ID Format`        events.jsonl                      # Raw SSE events (TRACE level only)        response.json                     # Response metadata + summary        request.json                      # Full request body sent to API      {chatId}/    requests/        errors.log                            # Error-level only (session-scoped)    gateway.log                           # Traditional rotating log (session-scoped)    requests.jsonl                        # Index: all requests in session    session.json                          # Session metadata  {sessionId}/    errors.jsonl                            # Index: all errors (cross-session)  sessions.jsonl                          # Index: all sessions{logDirectory}/`### Directory Structure## Design4. **Replay-ready structure** — Request payloads stored for immediate replay3. **JSONL indexes** — Fast lookup across sessions and requests2. **Request-level artifacts** — Full request/response capture per chat turn1. **Session-scoped logs** — Each VS Code window gets its own log directory### Goals4. **Manual replay** — Reproducing issues requires manually extracting request payloads3. **No cross-session analysis** — Can't easily compare behavior across sessions2. **No request correlation** — Hard to find all artifacts for a single request1. **No session isolation** — Logs from different VS Code windows intermingleThis creates several problems:- `api-errors.log`- `errors.log`- `gateway.log` / `gateway.1.log` (rotating)The existing logger writes to flat files in a single directory:### Current State## MotivationIntroduce a hierarchical, session-scoped logging architecture that enables efficient debugging, replay, and cross-session analysis of OpenResponses API interactions.## Summary**Author:** AI Gateway Team**Created:** 2026-01-30 **Stage:** 0 (Draft) ## Status

## Status

**Stage:** 0 (Draft)  
**Created:** 2026-01-30  
**Author:** AI Gateway Team

## Summary

Introduce a hierarchical, session-scoped logging architecture that enables efficient debugging, replay, and cross-session analysis of OpenResponses API interactions.

## Motivation

### Current State

The existing logger writes to flat files in a single directory:

- `gateway.log` / `gateway.1.log` (rotating)
- `errors.log`
- `api-errors.log`

This creates several problems:

1. **No session isolation** — Logs from different VS Code windows intermingle
2. **No request correlation** — Hard to find all artifacts for a single request
3. **No cross-session analysis** — Can't easily compare behavior across sessions
4. **Manual replay** — Reproducing issues requires manually extracting request payloads

### Goals

1. **Session-scoped logs** — Each VS Code window gets its own log directory
2. **Request-level artifacts** — Full request/response capture per chat turn
3. **JSONL indexes** — Fast lookup across sessions and requests
4. **Replay-ready structure** — Request payloads stored for immediate replay

## Design

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
        request.json                      # Full request body sent to API
        response.json                     # Response metadata + summary
        events.jsonl                      # Raw SSE events (TRACE level only)
```

### Session ID Format

```
{shortSessionId}-{date}
```

Where:

- `shortSessionId` = first 8 characters of `vscode.env.sessionId`
- `date` = ISO date (YYYY-MM-DD)

Example: `a1b2c3d4-2026-01-30`

### Index Schemas

#### `sessions.jsonl`

```jsonc
{
  "sessionId": "a1b2c3d4-2026-01-30",
  "startedAt": "2026-01-30T17:00:00.000Z",
  "vscodeVersion": "1.96.0",
  "extensionVersion": "0.2.3",
  "machineId": "...", // Optional, for cross-machine correlation
  "path": "a1b2c3d4-2026-01-30/",
}
```

#### `{sessionId}/requests.jsonl`

```jsonc
{
  "chatId": "abc12345-1706000000",
  "responseId": "gen_01KG...",
  "timestamp": "2026-01-30T17:45:00.000Z",
  "model": "anthropic/claude-opus-4.5",
  "inputTokens": 80000,
  "outputTokens": 500,
  "finishReason": "stop",
  "toolsSent": 45,
  "toolCallsEmitted": 3,
  "textParts": 12,
  "durationMs": 5200,
  "error": null,
  "path": "requests/abc12345-1706000000/",
}
```

#### `errors.jsonl` (root)

```jsonc
{
  "sessionId": "a1b2c3d4-2026-01-30",
  "chatId": "def67890-1706000100",
  "timestamp": "2026-01-30T17:46:40.000Z",
  "error": "input too long",
  "errorCode": "invalid_request_body",
  "tokenInfo": { "actual": 250000, "max": 200000 },
  "path": "a1b2c3d4-2026-01-30/requests/def67890-1706000100/",
}
```

### Request Artifacts

#### `request.json`

Full `CreateResponseBody` as sent to OpenResponses API:

```jsonc
{
  "model": "anthropic/claude-opus-4.5",
  "input": [...],
  "tools": [...],
  "tool_choice": "auto",
  "temperature": 0.7,
  "max_output_tokens": 4096,
  "instructions": "..."
}
```

#### `response.json`

Response metadata (not full output, which can be large):

```jsonc
{
  "responseId": "gen_01KG...",
  "model": "anthropic/claude-opus-4.5",
  "finishReason": "stop",
  "usage": {
    "input_tokens": 80000,
    "output_tokens": 500,
  },
  "timing": {
    "startedAt": "2026-01-30T17:45:00.000Z",
    "completedAt": "2026-01-30T17:45:05.200Z",
    "durationMs": 5200,
  },
  "summary": {
    "textParts": 12,
    "toolCallsEmitted": 3,
    "eventCount": 156,
  },
}
```

#### `events.jsonl` (TRACE only)

Raw SSE events for deep debugging:

```jsonc
{"seq":1,"type":"response.created","timestamp":"...","data":{...}}
{"seq":2,"type":"response.output_item.added","timestamp":"...","data":{...}}
{"seq":3,"type":"response.output_text.delta","timestamp":"...","data":{...}}
```

## Implementation

### Phase 1: Core Infrastructure

1. **Add session context to logger**
   - Store `sessionId` in `ExtensionLogger`
   - Initialize from `vscode.env.sessionId` at activation
   - Create session directory structure

2. **Session index management**
   - Append to `sessions.jsonl` on activation
   - Write `session.json` with metadata

3. **Migrate file logging to session directory**
   - Update `gateway.log` path to `{sessionId}/gateway.log`
   - Update `errors.log` path to `{sessionId}/errors.log`

### Phase 2: Request-Level Capture

4. **Create request directory on each chat**
   - Generate path: `{sessionId}/requests/{chatId}/`
   - Write `request.json` before API call

5. **Capture response metadata**
   - Write `response.json` after completion
   - Include timing, tokens, summary

6. **Append to request index**
   - Update `{sessionId}/requests.jsonl` with summary

7. **Append to error index on failure**
   - Update root `errors.jsonl` for cross-session visibility

### Phase 3: Event Capture (TRACE only)

8. **Optional SSE event logging**
   - When log level is TRACE, write `events.jsonl`
   - Each event as single JSONL line with sequence number

### Configuration

New settings:

```jsonc
{
  "vercelAI.logging.fileDirectory": "~/.vscode-ai-gateway/logs",
  "vercelAI.logging.captureRequests": true, // Enable request.json capture
  "vercelAI.logging.captureEvents": false, // Enable events.jsonl (requires TRACE)
}
```

Default behavior:

- `captureRequests`: `true` when `fileDirectory` is set
- `captureEvents`: `false` (opt-in, verbose)

## Query Patterns

### Find latest session

```bash
tail -1 .logs/sessions.jsonl | jq -r .path
```

### Find all requests in current session

```bash
cat .logs/$(tail -1 .logs/sessions.jsonl | jq -r .path)/requests.jsonl
```

### Find requests with no tool calls

```bash
jq 'select(.toolCallsEmitted == 0 and .finishReason == "stop")' .logs/*/requests.jsonl
```

### Find all errors

```bash
cat .logs/errors.jsonl
```

### Replay a specific request

```bash
cat .logs/{sessionId}/requests/{chatId}/request.json | node scripts/test-openresponses.ts -
```

### Find high-token requests

```bash
jq 'select(.inputTokens > 100000)' .logs/*/requests.jsonl
```

## Test Script Integration

Update `test-openresponses.ts` commands:

| Command                      | Behavior                                   |
| ---------------------------- | ------------------------------------------ |
| `replay`                     | Replay from `api-errors.log` (legacy)      |
| `replay-latest`              | Replay latest request from current session |
| `replay-session {sessionId}` | List requests in session, pick one         |
| `replay-path {path}`         | Replay from specific `request.json` path   |

## Future Work

### Out of Scope for This RFC

1. **Suspicious stop detection** — Heuristic-based flagging of premature stops
2. **Automatic cleanup/rotation** — Pruning old sessions
3. **Log aggregation UI** — VS Code webview for browsing logs
4. **Structured log format** — JSON-based gateway.log (vs plain text)

These are tracked separately and can build on this foundation.

## Migration

### Backward Compatibility

- Existing flat log files continue to work
- New structure created alongside if `fileDirectory` is set
- No breaking changes to configuration

### Rollout

1. Implement behind feature flag initially
2. Enable by default once stable
3. Document migration path for users with existing log analysis scripts

## Alternatives Considered

### Single JSONL file per session

**Rejected:** Harder to extract individual requests for replay; file grows unbounded.

### SQLite database

**Rejected:** Adds dependency; JSONL is more portable and grep-friendly.

### No indexes, just directory structure

**Rejected:** Indexes enable fast cross-session queries without traversing directories.

## References

- [RFC 015: Logging Infrastructure](015-logging-infrastructure.md) (if exists)
- [JSONL specification](https://jsonlines.org/)
- [VS Code Extension API: env](https://code.visualstudio.com/api/references/vscode-api#env)
