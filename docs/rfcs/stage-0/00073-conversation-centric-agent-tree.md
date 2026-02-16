---
title: Conversation-Centric Agent Tree
feature: Unknown
exo:
  tool: exo rfc create
  protocol: 1
---

# RFC 00073: Conversation-Centric Agent Tree

## Status

Stage 1 — Proposal (Phase 2 in progress)

## Summary

Redesign the agent tree as a **live activity log per conversation**, with turn-level entries,
compaction events, errors, and nested subagents. Conversations are the primary entity;
each conversation's children form a chronological log of what happened.

## Motivation

### Current Problems

1. **AgentEntry conflates identity and display** — An agent is both an identity (conversationId) and a display unit, making it awkward to show history or group related activity.

2. **Deletion vs archival** — Agents are removed after 5 newer completions, losing history. Users can't see what they were working on earlier.

3. **Compaction is transient** — Summarization events fade after 2 turns, but they're meaningful milestones in a conversation's lifecycle.

4. **No workspace scoping** — All conversations are shown regardless of relevance to current work.

5. **No turn-level visibility** — Users can't see what happened at each turn, making it hard to understand conversation flow.

### User Mental Model

Users think in terms of **conversations** — discrete sessions where they're working on a specific task. Each conversation is an **activity log**: a sequence of turns, compaction events, errors, and subagent invocations. The tree should reflect this chronological narrative.

## Design

### Core Principle: The Activity Log

Each conversation's children are a **chronological activity log** (newest first). This replaces the old model where conversations only showed subagents and compaction as children.

Log entry types:

- **Turn** — A user↔assistant exchange. May contain nested subagents.
- **CompactionEvent** — Summarization or context management milestone.
- **Error** — A failed turn or stream error.

### Tree Layout

**Top level** — Active conversations appear directly at the root. No "Active" section header.

```
▼ Login Bug Fix                             45k/128k · 35%
    ├─ Refactored auth middleware            2k out · 1 subagent
    ├─ ↓ Compacted 30k (turn 8)
    ├─ Investigated session handling         1.5k out
    ├─ ✗ Error: rate limit exceeded
    └─ ▸ History (12 earlier entries)
▼ API Refactor                              82k/128k · streaming...
    ├─ Extracting shared types               streaming...
    └─ ▸ History (3 earlier entries)
▽ History
    ▽ Status Bar Polish (2h ago)            idle
    ▽ Token Counter Tests (yesterday)       archived
```

**Children of a conversation** — Up to 5 most recent non-error entries, plus all recent errors. Older entries collapse into a nested "History" node.

**Children of a turn with subagents:**

```
▼ Refactored auth middleware               2k out · 1 subagent
    ▼ recon                                 8k · complete
        └─ recon-worker                     3k · complete
    └─ execute                              15k · complete
```

### Windowing: The 5-Entry Rule

Each conversation shows at most **5 recent non-error entries** in its activity log. Errors are shown in addition to (not instead of) the 5 entries, but they do age out — when an error would be the 6th entry by chrono position, it moves to History.

Older entries live in a nested **History** node per conversation. This keeps the tree compact while preserving full history.

### Core Entities

```typescript
interface Conversation {
  /** Stable UUID from VS Code's stateful marker sessionId */
  id: string;

  /** Human-readable title (AI-generated or from first message) */
  title: string;

  /** Preview of first user message (fallback for title) */
  firstMessagePreview?: string;

  /** Model used for this conversation */
  modelId: string;

  /** Lifecycle state */
  status: "active" | "idle" | "archived";

  /** Timestamps */
  startTime: number;
  lastActiveTime: number;

  /** Token usage (from most recent turn) */
  tokens: {
    input: number;
    output: number;
    maxInput: number;
  };

  /** Turn count and cumulative output */
  turnCount: number;
  totalOutputTokens: number;

  /** Activity log — all events in chronological order */
  activityLog: ActivityLogEntry[];

  /** Subagents spawned by this conversation */
  subagents: Subagent[];

  /** Workspace folder for scoping */
  workspaceFolder?: string;
}

/** Union of all entry types in the activity log */
type ActivityLogEntry = TurnEntry | CompactionEntry | ErrorEntry;

interface TurnEntry {
  type: "turn";
  turnNumber: number;
  timestamp: number;

  /** Turn lifecycle state */
  state: TurnState;

  /** Short characterization of what happened (from Copilot model) */
  characterization?: string;

  /** Output token count for this turn */
  outputTokens: number;

  /** IDs of subagents spawned during this turn (resolved via conversation.subagents) */
  subagentIds: string[];
}

/** Turn lifecycle states */
type TurnState =
  | "streaming" // Actively receiving tokens
  | "pending-characterization" // Complete, awaiting summary (≤10s window)
  | "characterized" // Complete with summary
  | "uncharacterized" // Complete, no summary (timed out or failed)
  | "interrupted"; // Was streaming when session ended (restored from persistence)

interface CompactionEntry {
  type: "compaction";
  timestamp: number;
  turnNumber: number;
  freedTokens: number;
  compactionType: "summarization" | "context_management";
  details?: string;
}

interface ErrorEntry {
  type: "error";
  timestamp: number;
  turnNumber?: number;
  message: string;
}

interface Subagent {
  conversationId: string;
  name: string;
  tokens: { input: number; output: number };
  turnCount: number;
  status: "streaming" | "complete" | "error";
  children: Subagent[]; // Nested subagents
}
```

### Turn State Machine

Turns follow a well-defined lifecycle with explicit state transitions:

```
                    ┌─────────────┐
                    │  streaming  │ ◄── Turn created when agent starts streaming
                    └──────┬──────┘
                           │
           ┌───────────────┼───────────────┐
           │               │               │
           ▼               ▼               ▼
    ┌─────────────┐  ┌───────────┐  ┌─────────────┐
    │ interrupted │  │  pending- │  │    error    │
    │             │  │  charact. │  │   (entry)   │
    └─────────────┘  └─────┬─────┘  └─────────────┘
                           │
              ┌────────────┴────────────┐
              │                         │
              ▼                         ▼
       ┌─────────────┐          ┌───────────────┐
       │characterized│          │uncharacterized│
       └─────────────┘          └───────────────┘
```

**State Transitions:**

| From                       | To                         | Trigger                                                      |
| -------------------------- | -------------------------- | ------------------------------------------------------------ |
| (none)                     | `streaming`                | Agent starts streaming (before `turnCount` increments)       |
| `streaming`                | `pending-characterization` | Turn completes (`turnCount` increments, agent not streaming) |
| `streaming`                | `interrupted`              | Session ends while streaming (restored from persistence)     |
| `streaming`                | (error entry)              | Stream error occurs                                          |
| `pending-characterization` | `characterized`            | Characterization arrives                                     |
| `pending-characterization` | `uncharacterized`          | 10-second timeout expires                                    |

**Key Invariants:**

1. At most one turn per conversation can be in `streaming` state
2. A turn is created immediately when streaming starts (before `turnCount` increments)
3. Turns restored from persistence are never `streaming` — they become `interrupted` if they were streaming when persisted
4. The 10-second characterization window is a view concern, not persisted state
5. Windowing (showing last 5 entries) is purely a view concern

**Display Mapping:**

| State                      | Icon                    | Description                          |
| -------------------------- | ----------------------- | ------------------------------------ |
| `streaming`                | `$(loading~spin)`       | "streaming..."                       |
| `pending-characterization` | `$(sync~spin)`          | "summarizing..." (within 10s window) |
| `characterized`            | `$(comment-discussion)` | Shows characterization text          |
| `uncharacterized`          | `$(comment-discussion)` | "Turn N"                             |
| `interrupted`              | `$(warning)`            | "Turn N (interrupted)"               |

### Tree Item Types

| Type                   | Description                       | Icon                    |
| ---------------------- | --------------------------------- | ----------------------- |
| `ConversationItem`     | Top-level conversation            | model-dependent         |
| `TurnItem`             | A user↔assistant exchange         | `$(comment-discussion)` |
| `TurnWithSubagentItem` | A turn that spawned subagents     | `$(type-hierarchy)`     |
| `StreamingTurnItem`    | A turn currently streaming        | `$(loading~spin)`       |
| `CompactionItem`       | Compaction event                  | `$(fold-down)`          |
| `ErrorItem`            | Failed turn or stream error       | `$(error)`              |
| `SubagentItem`         | Subagent node (nested under turn) | status-dependent        |
| `HistoryItem`          | "History (N earlier)" collapsible | `$(history)`            |
| `SectionHeader`        | "History" at top level            | `$(archive)`            |

### Turn Characterization

Each turn gets a short characterization (e.g., "Refactored auth middleware", "Added unit tests
for parser") generated by a free Copilot model (gpt-4o-mini). This follows the same pattern
as `TitleGenerator`.

**Data source**: The `StreamAdapter` already accumulates all response parts unconditionally
via `accumulatedParts` (used for `getFinalMessage()`). The chat handler also accumulates
`accumulatedText` (all `LanguageModelTextPart.value` concatenated). Either can feed
characterization without new collection overhead.

**Timing**: Characterization runs after each turn completes (stream done). It's asynchronous
and non-blocking — the tree shows "Turn N" with token counts immediately, then updates the
label when the characterization arrives.

**Fallback**: If characterization fails or hasn't arrived yet, the turn shows as
"Turn N · Xk out" (token count only). The first user message preview is also available
from `AgentEntry.firstUserMessagePreview`.

### Post-Restart Grace Period

When VS Code restarts, previous-session conversations should not immediately demote to
History. Instead:

- Previous-session conversations remain **active** at the top level
- They stay active until **a few minutes after the first new turn** in the current session
- This prevents the jarring experience of all conversations disappearing on restart
- If no new turns happen, previous-session conversations remain active indefinitely
  (the user is just reading, not actively chatting)

### Subagent Nesting

Subagents nest under the **turn that spawned them**, not directly under the conversation.
This creates a natural hierarchy:

```
Turn 5: "Refactored auth middleware"
  └─ recon (8k, complete)
      └─ recon-worker (3k, complete)
  └─ execute (15k, complete)
```

Subagent history stays nested — it never floats up to the top-level History section.
The top-level History only collects idle/archived **top-level conversations**.

### Decisions

| Question                    | Decision                    | Rationale                                                           |
| --------------------------- | --------------------------- | ------------------------------------------------------------------- |
| **Section headers**         | No "Active"; "History" only | Active conversations at root, less clutter                          |
| **Subagent nesting**        | Under spawning turn         | Natural hierarchy; shows what triggered subagents                   |
| **Compaction display**      | Separate log entries        | Each is a meaningful milestone in the activity log                  |
| **Active → History**        | 5 minutes idle              | Long enough for tab switches, short enough to be meaningful         |
| **Post-restart**            | Grace period                | Stay active until minutes after first new turn in new session       |
| **Activity log windowing**  | 5 non-error entries         | Keeps tree compact; errors don't count toward limit                 |
| **Activity log order**      | Reverse chronological       | Newest first, matches mental model of "what just happened"          |
| **Error counting**          | Don't count toward 5        | Errors are important but shouldn't push off context                 |
| **Error aging**             | Age out at 6th position     | Eventually errors do move to history when enough new entries arrive |
| **Turn characterization**   | Via Copilot model           | Rich labels without user cost; same pattern as TitleGenerator       |
| **Characterization data**   | From accumulatedText        | Already stored unconditionally for error reporting                  |
| **Characterization window** | 10 seconds                  | Show "summarizing..." spinner for recently completed turns          |
| **Subagent history**        | Stays nested under parent   | Never floats to top-level History                                   |
| **Workspace scoping**       | Track at start              | Simple, reliable; can enhance with file-mention detection later     |
| **Turn creation timing**    | When streaming starts       | Show turn immediately, before turnCount increments                  |
| **Restored streaming**      | Mark as "interrupted"       | Turns that were streaming when session ended get special state      |
| **Window size**             | Fixed at 5                  | Start simple; can make configurable later if needed                 |

### Retention & Persistence

1. **Active conversations** — Visible at tree root
2. **Idle conversations** — Move to History after 5 minutes of inactivity
3. **Archived conversations** — Keep for 7 days (matches existing persistence TTL)
4. **Persistence** — Use memento to survive VS Code reloads

**New persistence store:**

```typescript
interface ConversationState {
  id: string;
  title: string;
  status: "active" | "idle" | "archived";
  lastActiveTime: number;
  workspaceFolder?: string;
  activityLog: ActivityLogEntry[];
}

const CONVERSATION_STORE: StoreConfig<Record<string, ConversationState>> = {
  key: "vercel.ai.conversations",
  version: 1,
  scope: "global",
  defaultValue: {},
  maxEntries: 100,
  ttlMs: 7 * 24 * 60 * 60 * 1000, // 7 days
};
```

### Trim Feature

"Trim History" button in tree view header:

- Removes conversations where `workspaceFolder !== currentWorkspace`
- Only affects `archived` conversations
- Shows confirmation dialog with count

## Implementation Plan

### Phase 1: ConversationManager Core ✅

Created `src/conversation/` with `ConversationManager` that:

- Subscribes to `TokenStatusBar.onDidChangeAgents`
- Builds `Conversation` objects from `AgentEntry` data
- Tracks compaction events (cumulative summarization + per-turn context management)
- Builds nested subagent hierarchy with cycle protection

### Phase 2: Tree Items & Activity Log ✅

Rewrote `AgentTreeDataProvider` using `ConversationManager` as data source:

- ✅ Turn-level `TurnItem` tree items with activity log
- ✅ `CompactionItem` and `ErrorItem` log entries
- ✅ `SubagentItem` nested under spawning turn
- ✅ Per-conversation `HistoryItem` for older entries (windowing)
- ✅ Reverse chronological order (newest first)
- ✅ Turn characterization via Copilot model
- ✅ Persistence to memento storage
- ✅ Restoration on VS Code reload

### Phase 2.5: Turn State Machine (current)

Refactor turn tracking to use explicit state machine:

1. Replace `streaming: boolean` with `state: TurnState`
2. Implement state transitions in `ConversationManager`
3. Handle `interrupted` state for turns restored from persistence
4. Clean up ad-hoc streaming/finalization logic
5. Update tree items to use state-based display

### Phase 3: Polish & Edge Cases

1. Idle timer (5 minutes → move to History section)
2. Post-restart grace period
3. Environment-aware title generation refinement

### Phase 4: Workspace Scoping & Trim

1. Track `workspaceFolder` when conversation starts
2. Add "Trim History" command and button
3. Filter tree by workspace (optional setting)

## Migration

- Existing `AgentEntry` data converts to `Conversation` on the fly
- No breaking changes to `TokenStatusBar` API
- Persistence format is additive (new store alongside existing stores)
- `LastSessionTreeItem` → absorbed by post-restart grace period logic

## Existing Infrastructure (for turn characterization)

The following data is already captured unconditionally during streaming:

1. **`StreamAdapter.accumulatedParts`** — Every emitted `LanguageModelResponsePart` accumulated via `adapt()`. Available via `getFinalMessage()`.
2. **`accumulatedText`** in `openresponses-chat.ts` — All `LanguageModelTextPart.value` concatenated during streaming (line ~644). Used for diagnostics.
3. **`investigationHandle?.recorder?.recordEvent()`** — Every raw SSE event recorded for the investigation logger.

Turn characterization can piggyback on `accumulatedText` without adding new collection overhead.

## Open Questions

1. ~~Compaction event detail level~~ → Resolved: separate log entries with freed token counts

2. **Multi-workspace** — How to handle conversations that span multiple workspace folders?

3. **Search/filter** — Should we add search functionality to find old conversations?

4. ~~Characterization phasing~~ → Resolved: included in Phase 2 (small effort, polished labels from day one)

## References

- [docs/design/conversation-tree-model.md](../../design/conversation-tree-model.md) — Initial design exploration
- RFC 00033 — Agent identity tracking (conversationId infrastructure)
- `src/title-generator.ts` — Pattern for free-model characterization
- `src/provider/stream-adapter.ts` — `accumulatedParts` / `getFinalMessage()` for turn data
- `src/provider/openresponses-chat.ts` — `accumulatedText` captured during streaming
