# RFC 013: Tool Call Truncation for OpenResponses

## Status: Stage 0 (Strawman)

This RFC addresses a specific subset of RFC 010 (Smart Context Compaction): how to handle tool call history when context grows large, particularly given the Gateway implementation gap discovered during debugging.

## Problem

### The Gateway Gap

The OpenResponses specification supports `function_call` items as input (items are "bidirectional"), but the Vercel AI Gateway rejects them with `400 "Invalid input"`. This means we cannot send structured tool call history back to the API.

See: [GATEWAY_SPEC_GAP_REPORT.md](../../packages/openresponses-client/GATEWAY_SPEC_GAP_REPORT.md)

### Current Workaround

We convert tool calls/results to plain text:

```typescript
// Tool call → assistant message text
"[Tool Call: get_weather({\"city\":\"Paris\"}) -> call_id: call_123]";

// Tool result → user message text
"[Tool Result for call_123]: {\"temp\": 22, \"conditions\": \"sunny\"}";
```

This works but raises questions:

1. As conversations grow, tool call history consumes significant tokens
2. Text-based tool calls don't benefit from potential Claude context optimizations
3. We lose structured semantics that could enable smarter truncation

### Claude's Context Management

From Anthropic's documentation:

| Aspect                | Behavior                                          |
| --------------------- | ------------------------------------------------- |
| **Truncation**        | No automatic truncation - API errors if exceeded  |
| **Tool caching**      | `tool_use` and `tool_result` blocks ARE cacheable |
| **Extended thinking** | Thinking blocks auto-stripped between turns       |
| **Context awareness** | Claude 4.5 models track remaining token budget    |

**Key insight**: Claude preserves ALL previous turns completely. It does NOT do automatic truncation like some chat interfaces.

## Goals

1. **Keep recent tool cycles intact** - Claude needs complete call→result pairs for ongoing work
2. **Safely compress older tool history** - Reduce tokens while preserving essential facts
3. **Maintain task coherence** - Model should understand what was done and why
4. **Work within Gateway constraints** - Use text-based representation effectively

## Design: Tool History Tiers

```
┌─────────────────────────────────────────────────────────────┐
│ TIER 1: System + Original Intent                             │
│ - System prompt (always preserved)                           │
│ - First user message (the original task)                     │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ TIER 2: Historical Summary                                   │
│ - Compressed summary of old tool calls                       │
│ - "Previously: read 5 files, made 3 edits, ran 2 tests"     │
│ - Key facts extracted, details discarded                     │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ TIER 3: Recent Context (Last N turns)                        │
│ - Full text-based tool call/result representation            │
│ - Preserves complete call→result pairs                       │
│ - Keeps error details verbatim                               │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ TIER 4: Current Turn                                         │
│ - User's current request                                     │
│ - Active tool calls in progress                              │
└─────────────────────────────────────────────────────────────┘
```

## Tool Call Categories

Different tool calls have different truncation semantics:

| Category             | Examples                                | Truncation Strategy                     |
| -------------------- | --------------------------------------- | --------------------------------------- |
| **Read operations**  | `read_file`, `list_dir`, `grep_search`  | Aggressive - just note what was read    |
| **Write operations** | `create_file`, `replace_string_in_file` | Keep summary of what changed            |
| **Executions**       | `run_in_terminal`                       | Keep if error, summarize if success     |
| **Queries**          | `semantic_search`, `list_code_usages`   | Very aggressive - results are transient |

### Truncation Examples

**Before (full text):**

```
[Tool Call: read_file({"path":"/src/foo.ts","startLine":1,"endLine":50}) -> call_123]
[Tool Result for call_123]:
export function foo() {
  // ... 50 lines of code ...
}
```

**After (truncated):**

```
[Earlier: Read /src/foo.ts lines 1-50]
```

**Before (error case - preserve):**

```
[Tool Call: run_in_terminal({"command":"npm test"}) -> call_456]
[Tool Result for call_456]:
FAIL src/foo.test.ts
  ✕ should handle edge case (15ms)
    Error: Expected 42 but got undefined
    at Object.<anonymous> (foo.test.ts:23:5)
```

**After (error - keep verbatim or lightly compress):**

```
[Earlier: Ran `npm test` - FAILED: foo.test.ts:23 "Expected 42 but got undefined"]
```

## Implementation Sketch

```typescript
interface ToolCallEntry {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
  timestamp: number;
  tokenCount: number;
}

interface TruncationConfig {
  recentTurnsToKeep: number; // e.g., 6 (3 exchanges)
  maxHistorySummaryTokens: number; // e.g., 500
  preserveErrorsVerbatim: boolean; // true
}

class ToolHistoryManager {
  private history: ToolCallEntry[] = [];

  constructor(
    private config: TruncationConfig,
    private tokenCounter: TokenCounter,
  ) {}

  addToolCall(call: ToolCallEntry) {
    this.history.push(call);
  }

  getCompactedHistory(budgetTokens: number): string[] {
    const recent = this.history.slice(-this.config.recentTurnsToKeep);
    const older = this.history.slice(0, -this.config.recentTurnsToKeep);

    const messages: string[] = [];

    // Add summary of older tool calls
    if (older.length > 0) {
      messages.push(this.summarizeOldCalls(older));
    }

    // Add full representation of recent calls
    for (const entry of recent) {
      messages.push(this.formatToolCall(entry));
      messages.push(this.formatToolResult(entry));
    }

    return messages;
  }

  private summarizeOldCalls(calls: ToolCallEntry[]): string {
    const byCategory = this.groupByCategory(calls);
    const lines: string[] = ["[Earlier in this session:]"];

    for (const [category, entries] of byCategory) {
      lines.push(this.summarizeCategory(category, entries));
    }

    return lines.join("\n");
  }

  private summarizeCategory(
    category: string,
    entries: ToolCallEntry[],
  ): string {
    switch (category) {
      case "read":
        const files = [...new Set(entries.map((e) => e.args.path))];
        return `- Read ${entries.length} files: ${files.slice(0, 3).join(", ")}${files.length > 3 ? "..." : ""}`;

      case "write":
        return `- Made ${entries.length} edits to files`;

      case "terminal":
        const errors = entries.filter((e) => e.isError);
        if (errors.length > 0) {
          return `- Ran ${entries.length} commands (${errors.length} failed)`;
        }
        return `- Ran ${entries.length} commands successfully`;

      default:
        return `- ${entries.length} ${category} operations`;
    }
  }

  private groupByCategory(
    calls: ToolCallEntry[],
  ): Map<string, ToolCallEntry[]> {
    // Group by tool type: read, write, terminal, search, etc.
  }
}
```

## Message Format After Truncation

When truncation has occurred, the message history sent to OpenResponses looks like:

```json
{
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": "Help me refactor the auth module"
    },

    {
      "type": "message",
      "role": "assistant",
      "content": "[Earlier in this session:]\n- Read 5 files in src/auth/\n- Made 3 edits: auth.ts, middleware.ts, types.ts\n- Ran tests: 2 passed, 1 failed (token-refresh.test.ts:45)"
    },

    {
      "type": "message",
      "role": "user",
      "content": "Acknowledged previous context."
    },

    {
      "type": "message",
      "role": "assistant",
      "content": "[Tool Call: read_file({...}) -> call_recent_1]"
    },
    {
      "type": "message",
      "role": "user",
      "content": "[Tool Result for call_recent_1]: ...full content..."
    },

    { "type": "message", "role": "user", "content": "Now fix the failing test" }
  ]
}
```

## Open Questions

1. **When to trigger truncation?**
   - At a fixed token threshold?
   - When approaching context limit?
   - After N tool calls regardless of tokens?

2. **LLM-assisted summarization?**
   - Could use a fast model to summarize older context
   - Adds latency and cost
   - Heuristic summarization may be "good enough"

3. **User visibility?**
   - Should users see when truncation happened?
   - "⚠️ Context compacted to save tokens"

4. **Tool result caching?**
   - Could we cache tool results and reference by ID?
   - "Result cached as #R1: {tokens: 500}"
   - Would need separate cache management

## Dependencies

- RFC 009 (Token Counting) - ✅ Implemented
- RFC 010 (Smart Context Compaction) - This is a specialized subset
- Gateway spec gap needs to remain worked around

## Success Criteria

1. Conversations can continue 2-3x longer before context exhaustion
2. Model retains understanding of what files were edited and why
3. Error context is preserved for debugging continuity
4. No noticeable quality degradation for recent context

## Next Steps

1. [x] Implement basic `ToolHistoryManager` class - **DONE** (see `src/provider/tool-history.ts`)
2. [x] Add token counting for tool call entries - **DONE** (uses char-based estimation, can upgrade to TokenCounter)
3. [x] Create categorization logic for tool types - **DONE** (read/write/terminal/search/other)
4. [x] Build heuristic summarization (no LLM first) - **DONE** (summarizes by category, preserves errors)
5. [x] Create stateless `computeTruncation()` function - **DONE** (can analyze tool call list and decide truncation)
6. [x] Integrate with `translateRequest()` in `openresponses-chat.ts` - **DONE**:
   - `extractToolCallsFromMessages()` extracts tool calls from VS Code messages
   - `computeTruncationContext()` computes truncation decision
   - `translateMessage()` now accepts `truncationCtx` to skip truncated calls
   - Summary message injected when truncation applies
7. [x] Add configuration options - **DONE**:
   - `vercelAiGateway.toolHistory.recentCallsToKeep` (default: 6)
   - `vercelAiGateway.toolHistory.truncationThreshold` (default: 10000 chars)
8. [ ] Test with real multi-turn coding sessions
9. [ ] Add UI indicator when truncation occurs

## Implementation Files

- `src/provider/tool-history.ts` - Core truncation logic
- `src/provider/tool-history.test.ts` - Tests (20 passing)
- `src/provider/openresponses-chat.ts` - Integration (extractToolCallsFromMessages, computeTruncationContext)
- `src/config.ts` - Configuration getters
- `package.json` - Settings schema
