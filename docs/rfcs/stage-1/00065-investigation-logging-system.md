---
title: Investigation Logging System
feature: logging
exo:
  tool: exo rfc create
  protocol: 1
---

# RFC 00065: Investigation Logging System

## Summary

Replace ad-hoc logging infrastructure (validation-log, forensic-capture, debug-utils) with a hierarchical, investigation-scoped logging system that captures all external system interactions in a structured, navigable file hierarchy.

## Motivation

We currently have four independent logging mechanisms:

1. **`logger.ts`** — Human-readable output channel + `.logs/current.log`
2. **`validation-log.ts`** — Token estimate vs actual to `.logs/token-validation.jsonl`
3. **`forensic-capture.ts`** — Full request capture to `~/.vscode-ai-gateway/forensic-captures.jsonl`
4. **`debug-utils.ts`** — Suspicious request dump to `.logs/last-suspicious-request.json`

Problems:

- Logs from different investigations mix together in flat files
- No way to correlate a specific conversation's requests without manual grep
- No table of contents — you have to read everything to find anything
- Old logs from previous investigations create noise
- SSE event streams are never captured, making stream-level debugging impossible
- Each mechanism has its own trigger, format, and location

## Design

### File Hierarchy

```
.logs/
  {{investigation-name}}/
    index.jsonl                          # One line per request — the table of contents
    {{conversationId}}/
      messages.jsonl                     # One line per request — more detail than index
      messages/
        {{chatId}}.json                  # Full request + response data
        {{chatId}}.sse.jsonl             # Raw SSE events (one line per event)
```

**Identity mapping:**

- `{{investigation-name}}` — User-configured scope (default: `"default"`)
- `{{conversationId}}` — Stable UUID from stateful marker sessionId, persists across turns
- `{{chatId}}` — Per-request identifier (`chat-${hash}-${timestamp}`), available at request start

### Detail Levels

| Level      | `index.jsonl` | `messages.jsonl` | `{{chatId}}.json` | `{{chatId}}.sse.jsonl` |
| ---------- | ------------- | ---------------- | ----------------- | ---------------------- |
| `off`      | —             | —                | —                 | —                      |
| `index`    | ✅            | —                | —                 | —                      |
| `messages` | ✅            | ✅               | ✅                | —                      |
| `full`     | ✅            | ✅               | ✅                | ✅                     |

### Settings

```json
{
  "vercel.ai.investigation.name": {
    "type": "string",
    "default": "default",
    "description": "Investigation name for scoped logging. Detailed request/response data is captured to .logs/{{name}}/. Change the name to start a clean investigation scope."
  },
  "vercel.ai.investigation.detail": {
    "type": "string",
    "enum": ["off", "index", "messages", "full"],
    "default": "off",
    "description": "Investigation logging detail level. At 'messages' and 'full' levels, complete request and response bodies are captured — do not use in production or commit these logs. The extension will warn if the logs directory is inside a git repository but not in .gitignore.",
    "enumDescriptions": [
      "Disable investigation logging",
      "Log index entries only (one line per request with timing, token counts, status)",
      "Log index + per-conversation message summaries + full request/response bodies",
      "Log everything including raw SSE event streams"
    ]
  }
}
```

### Schemas

#### Index Entry (`index.jsonl`)

Written for every request at all non-off detail levels. This is the table of contents — scannable with `jq` to find conversations and requests of interest.

```typescript
interface IndexEntry {
  // Timing
  ts: string; // ISO timestamp
  durationMs: number; // Total request duration
  ttftMs: number | null; // Time to first token

  // Identity
  conversationId: string; // Stable conversation UUID
  chatId: string; // Per-request ID
  responseId: string | null; // API response ID (null if errored before response)

  // Model
  model: string; // e.g. "anthropic/claude-opus-4"
  modelFamily: string; // e.g. "claude-opus"

  // Request summary
  messageCount: number;
  toolCount: number;
  estimatedInputTokens: number;

  // Response summary
  status: "success" | "error" | "cancelled" | "timeout";
  finishReason: string | null; // "stop" | "length" | "tool-calls" | etc.
  actualInputTokens: number | null;
  actualOutputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;

  // Token accuracy (replaces validation-log.ts)
  tokenDelta: number | null; // estimated - actual
  tokenDeltaPct: number | null; // percentage

  // Flags
  isSummarization: boolean; // Detected as Copilot summarization request
}
```

#### Message Summary (`messages.jsonl`)

Written per-request within the conversation directory. More context than the index — enough to understand the request without reading the full body.

```typescript
interface MessageSummary {
  ts: string;
  conversationId: string;
  chatId: string;
  responseId: string | null;

  // Request metadata
  model: string;
  systemPromptHash: string | null;
  systemPromptLength: number | null;
  messageRoles: string; // e.g. "User,Assistant,User,Assistant,User"
  toolNames: string[]; // First 10 tool names

  // Token breakdown
  estimate: {
    total: number;
    messages: number;
    tools: number;
    systemPrompt: number;
  };
  actual: {
    input: number | null;
    output: number | null;
    cached: number | null;
    reasoning: number | null;
  };

  // Response metadata
  status: "success" | "error" | "cancelled" | "timeout";
  finishReason: string | null;
  textPartCount: number;
  toolCallCount: number;
  eventCount: number;
  durationMs: number;
  ttftMs: number | null;

  // Error info
  error: string | null;
}
```

#### Full Request Capture (`messages/{{chatId}}.json`)

Written at `messages` and `full` levels. The complete picture of a single request.

```typescript
interface FullRequestCapture {
  ts: string;
  conversationId: string;
  chatId: string;
  responseId: string | null;

  // VS Code environment
  env: {
    sessionId: string;
    appName: string;
  };

  // Request (what we sent to OpenResponses)
  request: {
    model: string;
    input: unknown[]; // Full translated messages (ItemParam[])
    instructions: string | null; // System prompt
    tools: unknown[]; // Full tool schemas
    toolChoice: string;
    temperature: number;
    maxOutputTokens: number;
    promptCacheKey: string;
    caching: string;
  };

  // Response
  response: {
    status: string;
    finishReason: string | null;
    usage: unknown | null; // Full usage object with details
    error: string | null;
  };

  // Timing
  timing: {
    startMs: number;
    ttftMs: number | null;
    endMs: number;
    durationMs: number;
  };

  // Flags
  isSummarization: boolean;
}
```

#### SSE Events (`messages/{{chatId}}.sse.jsonl`)

Written at `full` level only. One line per SSE event. All 24 event types captured.

```typescript
interface SSEEventEntry {
  seq: number; // Event sequence number (0-indexed)
  ts: string; // ISO timestamp
  elapsed: number; // Milliseconds since request start
  type: string; // Event type (e.g. "response.output_text.delta")
  payload: unknown; // Raw event data
}
```

### Implementation

#### Single Chokepoint

All investigation logging wires through `executeOpenResponsesChat()` in `openresponses-chat.ts`. This function:

1. Receives all request data from VS Code
2. Translates messages
3. Sends to OpenResponses API
4. Processes all SSE events
5. Returns completion data

An `InvestigationLogger` instance is created at the start and accumulates data through the lifecycle.

#### InvestigationLogger Class

```typescript
class InvestigationLogger {
  constructor(config: { name: string; detail: DetailLevel; logDir: string });

  // Called at request start
  startRequest(conversationId: string, chatId: string, model: string, ...): void;

  // Called per SSE event (full level only)
  recordSSEEvent(seq: number, type: string, payload: unknown): void;

  // Called at request completion
  completeRequest(result: { status, usage, responseId, ... }): Promise<void>;

  // All file I/O happens in completeRequest (single async flush)
}
```

File I/O is async and fire-and-forget — investigation logging must never block or crash the extension.

#### Gitignore Warning

On activation, if the investigation detail is `messages` or `full`:

1. Check if the logs directory is inside a git repository (`git rev-parse --git-dir`)
2. Check if `.logs/` is in `.gitignore`
3. If in git but not ignored, show an information message: "Investigation logging captures request/response data. Consider adding `.logs/` to your `.gitignore`."

### Pruning

#### `vercel.ai.investigation.prune` Command

Interactive command that:

1. Lists investigation directories with summary stats (entry count, disk size, date range)
2. For `default` investigation: offers age-based pruning (older than N hours/days)
3. User checks which investigations/ranges to prune
4. Prune spiders from index outward:
   - Read `index.jsonl`, identify entries to remove
   - For each removed entry: delete `messages/{{chatId}}.json` and `messages/{{chatId}}.sse.jsonl`
   - Rewrite `messages.jsonl` for affected conversations
   - Rewrite `index.jsonl` without pruned entries
   - Remove empty conversation directories
5. This ordering ensures no dangling references or silently missing data

### Migration Plan

#### Phase 1: Implement InvestigationLogger

- New `src/logger/investigation.ts` module
- Add settings to `package.json` and `config.ts`
- Wire into `executeOpenResponsesChat`

#### Phase 2: Migrate Existing Logging

- `validation-log.ts` → `tokenDelta`/`tokenDeltaPct` fields in IndexEntry
- `forensic-capture.ts` → FullRequestCapture at `messages`/`full` level
- `debug-utils.ts` → superseded by FullRequestCapture at `messages` level
- Stop writing to old locations when investigation logging is active

#### Phase 3: Cleanup

- Remove `validation-log.ts`, `forensic-capture.ts`, `debug-utils.ts` (saveSuspiciousRequest)
- Archive existing `.logs/token-validation.jsonl` and `.logs/last-suspicious-request.json`
- Remove `~/.vscode-ai-gateway/forensic-captures.jsonl`
- Update all references

### What This Replaces

| Current                                                                | Replaced By                           | Detail Level |
| ---------------------------------------------------------------------- | ------------------------------------- | ------------ |
| `validation-log.ts` → `.logs/token-validation.jsonl`                   | `IndexEntry.tokenDelta/tokenDeltaPct` | `index`      |
| `forensic-capture.ts` → `~/.vscode-ai-gateway/forensic-captures.jsonl` | `FullRequestCapture`                  | `messages`   |
| `debug-utils.ts` → `.logs/last-suspicious-request.json`                | `FullRequestCapture`                  | `messages`   |
| (nothing)                                                              | `SSEEventEntry` stream                | `full`       |

### What This Does NOT Replace

- **`logger.ts`** — Remains as human-readable Output Channel + rotation logs. Orthogonal to investigation logging.
- **`treeDiagnostics`** — Diagnostic tree snapshots for sidebar/identity debugging. Different purpose.
