---
title: Conversation-Centric Agent Tree
feature: Unknown
exo:
    tool: exo rfc create
    protocol: 1
---

# RFC 00073: Conversation-Centric Agent Tree

## Status

Stage 0 — Idea

## Summary

Redesign the agent tree to use **Conversation** as the primary entity instead of **AgentEntry**. This provides a clearer mental model for users, better support for history and compaction events, and workspace-scoped retention.

## Motivation

### Current Problems

1. **AgentEntry conflates identity and display** — An agent is both an identity (conversationId) and a display unit, making it awkward to show history or group related activity.

2. **Deletion vs archival** — Agents are removed after 5 newer completions, losing history. Users can't see what they were working on earlier.

3. **Compaction is transient** — Summarization events fade after 2 turns, but they're meaningful milestones in a conversation's lifecycle.

4. **No workspace scoping** — All conversations are shown regardless of relevance to current work.

### User Mental Model

Users think in terms of **conversations** — discrete sessions where they're working on a specific task. Each conversation:

- Has a topic/title (what they're working on)
- Has turns (back-and-forth exchanges)
- May spawn subagents (recon, execute, etc.)
- May get compacted (summarized) when context fills up
- Eventually becomes inactive but shouldn't disappear

## Design

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

  /** Compaction events (summarization, context management) */
  compactionEvents: CompactionEvent[];

  /** Subagents spawned by this conversation */
  subagents: Subagent[];

  /** Workspace folder for scoping */
  workspaceFolder?: string;
}

interface CompactionEvent {
  timestamp: number;
  turnNumber: number;
  freedTokens: number;
  type: "summarization" | "context_management";
  details?: string;
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

### Tree Structure

**Active conversation with subagents and compaction:**

```
▼ Active
    ▼ Login Bug Fix                         45k/128k · 35%
        ├─ ↓ Compacted 30k (turn 8)
        ▼ recon                             8k · complete
            └─ recon-worker                 3k · complete
        └─ execute                          15k · streaming...
```

**History section (dimmed, collapsed by default):**

```
▽ History
    ▽ Status Bar Polish (2h ago)            82k/128k · idle
        └─ ↓ Compacted 25k (turn 5)
    ▽ Token Counter Tests (yesterday)       archived
```

### Tree Item Types

| Type               | Description           | Icon                 |
| ------------------ | --------------------- | -------------------- |
| `SectionHeader`    | "Active" or "History" | folder               |
| `ConversationItem` | Main conversation     | model-dependent or ▲ |
| `CompactionItem`   | Compaction event      | fold-down (↓)        |
| `SubagentItem`     | Subagent node         | depends on status    |

### Decisions

| Question               | Decision        | Rationale                                                       |
| ---------------------- | --------------- | --------------------------------------------------------------- |
| **Subagent nesting**   | Nested          | Shows true hierarchy (recon → recon-worker)                     |
| **Compaction display** | Separate events | Each is a meaningful milestone; can aggregate later if noisy    |
| **Active → History**   | 5 minutes idle  | Long enough for tab switches, short enough to be meaningful     |
| **Workspace scoping**  | Track at start  | Simple, reliable; can enhance with file-mention detection later |

### Retention & Persistence

1. **Active conversations** — Always visible
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
  compactionEvents: CompactionEvent[];
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

### Phase 1: ConversationManager (non-breaking)

1. Create `ConversationManager` class that:
   - Subscribes to `TokenStatusBar.onDidChangeAgents`
   - Builds `Conversation` objects from `AgentEntry` data
   - Tracks compaction events when `summarizationDetected` fires
   - Manages Active/History transitions based on idle time

2. Update `AgentTreeDataProvider` to:
   - Use `ConversationManager` as data source
   - Render new tree item types (SectionHeader, ConversationItem, etc.)
   - Support nested subagents

3. Keep `AgentEntry` and `TokenStatusBar` unchanged

### Phase 2: Persistence

1. Add `CONVERSATION_STORE` to persistence layer
2. Persist conversation metadata on state changes
3. Restore conversations on VS Code restart
4. Implement 5-minute idle timer with persistence

### Phase 3: Workspace Scoping

1. Track `workspaceFolder` when conversation starts
2. Add "Trim History" command and button
3. Filter tree by workspace (optional setting)

## Migration

- Existing `AgentEntry` data converts to `Conversation` on the fly
- No breaking changes to `TokenStatusBar` API
- Persistence format is additive (new store alongside existing stores)

## Open Questions

1. **Compaction event detail level** — Should we show what was compacted (tool uses, thinking turns)?

2. **Multi-workspace** — How to handle conversations that span multiple workspace folders?

3. **Search/filter** — Should we add search functionality to find old conversations?

## References

- [docs/design/conversation-tree-model.md](../../design/conversation-tree-model.md) — Initial design exploration
- RFC 00033 — Agent identity tracking (conversationId infrastructure)
