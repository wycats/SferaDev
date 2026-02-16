---
title: "Shared Perception: Event-Sourced Tree State and Self-Describing CLI"
feature: logging
exo:
  tool: exo rfc create
  protocol: 1
---

# RFC 00075: Shared Perception — Event-Sourced Tree State and Self-Describing CLI

## Summary

Consolidate the extension's logging infrastructure into a single **unified event stream** (`events.jsonl`) that captures enough information to reconstruct the user's agent tree view. Replace the standalone `tree-changes.jsonl` file with event-sourced tree state (deltas + rollup snapshots). Add fork detection when users edit messages. Redesign the CLI (`query-events.ts`) as a **self-describing, composable interface** that agents use exclusively — never reading files directly.

## Motivation

### The Shared Perception Problem

The extension maintains a rich visual representation of AI conversations in the agent tree view. An agent collaborating with the user needs to understand what the user sees — but today there's no reliable way to do this:

1. **No events.jsonl is being written** — the unified subscriber is wired but the file doesn't exist. The infrastructure exists but hasn't been validated end-to-end.

2. **Duplicate logging systems** — `tree-changes.jsonl` (982 MB!) writes full snapshots on every micro-change, while the unified stream's `tree.change` event carries only a stripped-down diff. Neither is sufficient alone.

3. **No fork detection** — when a user edits a message, VS Code creates a new request with modified history. The extension doesn't detect this, leading to activity logs that don't match reality.

4. **CLI requires file knowledge** — the current `query-events.ts` is a thin wrapper around file reads. An agent using it still needs to understand the file format, use `jq`/`grep` for anything beyond the built-in commands, and remember what IDs mean.

### What We Deleted

As part of this work, we deleted 4.3 GB of stale logs:

- `.reference/SferaDev/.logs/` — 3.3 GB, 6,674 files from earlier architectures
- `exo2/.logs/` — 1 GB, including 982 MB `tree-changes.jsonl`

## Design

### Principle: The CLI Is the API

**Design goal: An agent should be able to do _everything_ through the CLI and never need to read files.**

The moment an agent starts reading files, it wastes tokens trying to understand structure from first principles. The CLI must be:

1. **Self-describing** — every output includes the command to run for more detail
2. **Composable** — output of one command feeds into another command, not into `jq` or `grep`
3. **Complete** — any information in `events.jsonl` is accessible through a command
4. **Actionable** — outputs tell the agent what to do next, not just what happened

Example of self-describing output:

```
=== Agent Tree (current) ===

▼ Claude 4 Opus — Refactoring auth module    45k/128k · 35%
  ├─ "How do I fix the bug..."               #42 · +0.3k
  │   ├─ Read the logs                       #42 · read_file · +0.5k
  │   └─ Found the issue                     #43 · grep_search · +0.8k
  └─ "Now update the tests"                  #44 · +0.2k
      └─ (streaming...)

Hint: query-events conversation <id>    # Full history for a conversation
Hint: query-events request <chatId>     # Details of a specific request
```

Every ID shown is a valid argument to another command. Every section suggests the next action.

### Event-Sourced Tree State

Instead of persisting full tree snapshots on every change, we use **event sourcing**: granular deltas that, when replayed, reconstruct the tree. Periodic rollup snapshots provide efficient random access.

#### Deltas (`tree.change`)

Emitted on every conversation state change. Each carries a discriminated `op` field with enough data to _apply_ the change:

```typescript
interface TreeChangeEvent extends InvestigationEventBase {
  kind: "tree.change";
  op: TreeChangeOp;
}

type TreeChangeOp =
  // Conversation lifecycle
  | { type: "conversation-added"; conversation: ConversationSnapshot }
  | { type: "conversation-removed"; conversationId: string }
  | {
      type: "conversation-forked";
      conversationId: string; // the new/continuing conversation
      forkedFrom: string; // the original conversation (if different)
      atSequence: number; // where the edit happened
      previousMessageCount: number; // messages before the edit
      newMessageCount: number; // messages after the edit
    }
  // Conversation field updates
  | { type: "status-changed"; conversationId: string; status: string }
  | { type: "title-changed"; conversationId: string; title: string }
  | {
      type: "tokens-updated";
      conversationId: string;
      tokens: { input: number; output: number; maxInput: number };
    }
  // Activity log entries (creates)
  | {
      type: "user-message-added";
      conversationId: string;
      entry: UserMessageSnapshot;
    }
  | {
      type: "ai-response-added";
      conversationId: string;
      entry: AIResponseSnapshot;
    }
  | {
      type: "compaction-added";
      conversationId: string;
      entry: CompactionSnapshot;
    }
  | { type: "error-added"; conversationId: string; entry: ErrorSnapshot }
  // Activity log entries (updates)
  | {
      type: "ai-response-updated";
      conversationId: string;
      sequenceNumber: number;
      fields: Partial<AIResponseSnapshot>;
    }
  | {
      type: "ai-response-characterized";
      conversationId: string;
      sequenceNumber: number;
      characterization: string;
    }
  // Subagents
  | {
      type: "subagent-added";
      conversationId: string;
      subagent: SubagentSnapshot;
    };
```

#### Rollup Snapshots (`tree.snapshot`)

Full conversation state, emitted at natural lifecycle boundaries:

```typescript
interface TreeSnapshotEvent extends InvestigationEventBase {
  kind: "tree.snapshot";
  trigger: "session-start" | "idle" | "removed" | "session-end";
  conversations: ConversationSnapshot[];
}
```

Rollup triggers:

- **Session start** — baseline state (may include restored conversations)
- **Conversation goes idle** — natural boundary after activity stops
- **Conversation removed/archived** — final state before removal
- **Session end** — final state for the session

#### Reconstruction Algorithm

1. Find the most recent `tree.snapshot` → base state
2. Apply all `tree.change` events after it → current state
3. If no snapshot exists, replay from session start

The CLI's `tree` command does this internally — the agent never needs to know the algorithm.

#### Snapshot Types

Enriched to include all fields needed to reconstruct the tree view:

```typescript
interface ConversationSnapshot {
  id: string;
  title: string;
  modelId: string;
  status: "active" | "idle" | "archived";
  startTime: number;
  lastActiveTime: number;
  tokens: { input: number; output: number; maxInput: number };
  turnCount: number;
  totalOutputTokens: number;
  activityLog: ActivityLogSnapshot[];
  subagents: SubagentSnapshot[];
  forkedFrom?: { conversationId: string; atSequence: number };
}

type ActivityLogSnapshot =
  | UserMessageSnapshot
  | AIResponseSnapshot
  | CompactionSnapshot
  | ErrorSnapshot;

interface UserMessageSnapshot {
  type: "user-message";
  sequenceNumber: number;
  timestamp: number;
  preview?: string;
  tokenContribution?: number;
  isToolContinuation?: boolean;
}

interface AIResponseSnapshot {
  type: "ai-response";
  sequenceNumber: number;
  timestamp: number;
  state: string; // "streaming" | "pending-characterization" | "characterized" | "uncharacterized" | "interrupted"
  characterization?: string;
  tokenContribution: number;
  subagentIds: string[];
  toolsUsed?: string[];
}

interface CompactionSnapshot {
  type: "compaction";
  timestamp: number;
  turnNumber: number;
  freedTokens: number;
  compactionType: string; // "summarization" | "context_management"
  details?: string;
}

interface ErrorSnapshot {
  type: "error";
  timestamp: number;
  turnNumber?: number;
  message: string;
}

interface SubagentSnapshot {
  id: string;
  name: string;
  status: string; // "streaming" | "complete" | "error"
  tokens: { input: number; output: number };
  turnCount: number;
  children: SubagentSnapshot[];
}
```

### Fork Detection

When a user edits a message in VS Code chat, the extension receives a new request with modified history. Currently this is invisible — the extension either resumes the same conversation (if the `stateful_marker` survives) or creates a new one.

#### Detection Mechanism

In the provider's `provideLanguageModelChatResponse`, when resuming a conversation (`prevContext` exists):

1. Compare `chatMessages.length` against `prevContext.lastMessageCount`
2. If `chatMessages.length < prevContext.lastMessageCount`, this is a fork (messages were removed)
3. If messages at positions `0..N` don't match the expected hashes, this is a fork (messages were edited)
4. Compute the fork point: the last message index where history matches

#### Fork Handling

1. Emit a `conversation-forked` tree change event
2. Reset the activity log to the fork point (discard entries after the edited message)
3. The conversation continues from the fork point with the new message
4. The snapshot carries `forkedFrom` metadata for provenance

#### What the Agent Sees

```
=== Conversation: Refactoring auth module ===
Status: active (forked from turn 3)

  #1  "How do I fix the bug..."          +0.3k
  #2  Read the logs                      +0.5k  (read_file)
  #3  Found the issue                    +0.8k  (grep_search)
  --- forked here (user edited message #4) ---
  #4  "Actually, let's try a different approach"  +0.2k
  #5  (streaming...)

Forked from: abc123 at sequence 3
Previous branch had 7 turns (now abandoned)
```

### CLI Commands

The redesigned CLI provides these commands. Every command's output includes hints for the next command to run.

| Command               | Purpose                                        | Key output                     |
| --------------------- | ---------------------------------------------- | ------------------------------ |
| `tree`                | Current agent tree (reconstructed from events) | Visual tree + conversation IDs |
| `tree --at <eventId>` | Tree state at a point in time                  | Same as `tree` but historical  |
| `session`             | Session overview (tokens, requests, errors)    | Summary + conversation list    |
| `conversation <id>`   | Full conversation history                      | Activity log + fork info       |
| `request <chatId>`    | All events for a specific request              | Timeline + causality           |
| `trace <chatId>`      | Causality chain (what did this request cause?) | Cause → effect chain           |
| `errors`              | All error events                               | Error list + request IDs       |
| `tail [--count N]`    | Last N events                                  | Event list                     |
| `kinds`               | Event kind distribution                        | Histogram                      |
| `search <text>`       | Full-text search                               | Matching events                |

New commands vs current:

- **`tree`** — reconstructs and displays the agent tree (the key "shared perception" command)
- **`conversation`** — replaces needing to grep by conversationId
- **`tree --at`** — time-travel to any point in the session

### What Gets Removed

1. **`tree-changes.jsonl` standalone file** — replaced by `tree.change` events in the unified stream
2. **`tree-change-log.ts` file I/O** — the class keeps its diff detection logic but stops writing files; emits directly to the unified stream
3. **`tree-change-bridge.ts`** — unnecessary indirection; the tree-change-log emits events directly
4. **Legacy log files** — `current.log`, `previous.log`, `errors.log`, `tree-diagnostics.log`, `tree-diagnostics/` directory (all already deleted)

### What Stays

1. **`unified-log-subscriber.ts`** — writes `events.jsonl` (the single log file)
2. **`investigation.ts`** — per-request file logging (index.jsonl, messages, SSE) gated by detail level
3. **`error-capture.ts`** — always-on error logs in globalStorage (separate concern)
4. **`registry-event-bridge.ts`** — agent lifecycle events
5. **`tree-diagnostics.ts`** — output channel logging (no file I/O)

## Implementation Plan

### Phase 1: Event Schema + Subscriber Fix

1. Define `TreeChangeOp` types and enriched snapshot types
2. Replace `InvestigationTreeChangeEvent` with new schema
3. Verify `createUnifiedLogSubscriber()` actually writes `events.jsonl`
4. Emit `tree.snapshot` on session start/end

### Phase 2: Tree-Change-Log Consolidation

1. Remove file I/O from `TreeChangeLogger`
2. Have `TreeChangeLogger` emit `tree.change` events with typed `op` directly
3. Remove `tree-change-bridge.ts`
4. Emit rollup snapshots at lifecycle boundaries

### Phase 3: Fork Detection

1. Add message history tracking to provider context
2. Detect forks on conversation resume
3. Emit `conversation-forked` events
4. Reset activity log to fork point

### Phase 4: Self-Describing CLI

1. Add `tree` command (reconstruct from events)
2. Add `conversation` command
3. Add `tree --at` time-travel
4. Make all outputs self-describing (include next commands)
5. Ensure all IDs in output are valid arguments to other commands

## Alternatives Considered

### Full snapshots on every change

The previous `tree-changes.jsonl` approach. Produced 982 MB of data because every token update wrote a full tree snapshot. Rejected for space inefficiency.

### Snapshots only (no deltas)

Periodic snapshots without deltas. Loses the ability to see exactly what changed between snapshots. Rejected because the change history is valuable for debugging.

### Throttled/debounced snapshots

Snapshot every N changes or every T seconds. Arbitrary boundaries that don't align with meaningful state transitions. Rejected in favor of lifecycle-triggered rollups.

### File-based CLI (current approach)

The current `query-events.ts` reads files and formats output. Agents still need to understand file structure for anything beyond built-in commands. Rejected because it violates the "CLI is the API" principle.

## Open Questions

1. Should the CLI support a `--watch` mode that tails events in real-time?
2. Should rollup snapshots include restored (persisted) conversations, or only active ones?
3. How should the CLI handle multiple sessions in the same events.jsonl file?
4. Should the `tree` command output be designed for a specific terminal width, or adapt?
