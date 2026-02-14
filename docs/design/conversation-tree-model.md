# Conversation-Centric Agent Tree Design

## Overview

This document describes a redesign of the agent tree to use **Conversation** as the primary entity, replacing the current agent-centric model. The goal is to provide a clearer mental model for users and better support for history, compaction events, and workspace-scoped retention.

## Current State

### Problems with Current Model

1. **AgentEntry conflates identity and display** — An agent is both an identity (conversationId) and a display unit, making it awkward to show history or group related activity.

2. **Deletion vs archival** — Agents are removed after 5 newer completions, losing history. Users can't see what they were working on earlier.

3. **Compaction is transient** — Summarization events fade after 2 turns, but they're meaningful milestones in a conversation's lifecycle.

4. **No workspace scoping** — All conversations are shown regardless of relevance to current work.

### Current Data Flow

```
Provider.provideLanguageModelChatResponse()
  → StatusBar.startAgent(agentId, ..., conversationId)
  → AgentEntry created/resumed
  → AgentTreeDataProvider.getChildren() renders AgentEntry[]
```

## Proposed Model

### Core Entities

```typescript
/**
 * A conversation represents a complete interaction session with the AI.
 * It groups all turns, subagents, and lifecycle events.
 */
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

  /** When the conversation started */
  startTime: number;

  /** When the conversation was last active */
  lastActiveTime: number;

  /** Token usage (from most recent turn) */
  tokens: {
    input: number;
    output: number;
    maxInput: number;
  };

  /** Number of completed turns */
  turnCount: number;

  /** Cumulative output tokens across all turns */
  totalOutputTokens: number;

  /** Compaction events (summarization, context management) */
  compactionEvents: CompactionEvent[];

  /** Subagents spawned by this conversation */
  subagents: Subagent[];

  /** Workspace folder this conversation is associated with (for scoping) */
  workspaceFolder?: string;
}

/**
 * A compaction event records when context was reduced.
 */
interface CompactionEvent {
  /** When the compaction occurred */
  timestamp: number;

  /** Turn number when compaction happened */
  turnNumber: number;

  /** Tokens freed by this compaction */
  freedTokens: number;

  /** Type of compaction */
  type: "summarization" | "context_management";

  /** Additional details (e.g., what was cleared) */
  details?: string;
}

/**
 * A subagent is a child conversation spawned by runSubagent.
 */
interface Subagent {
  /** Subagent's conversation ID */
  conversationId: string;

  /** Name from claim (e.g., "recon", "execute") */
  name: string;

  /** Token usage */
  tokens: {
    input: number;
    output: number;
  };

  /** Number of turns */
  turnCount: number;

  /** Status */
  status: "streaming" | "complete" | "error";
}
```

### Tree Structure

```
▼ Active                                    [section header]
    ▼ Login Bug Fix                         45k/128k · 35%
        ├─ ↓ Compacted 30k (turn 8)         [CompactionEvent]
        ├─ recon                            8k · complete
        └─ execute                          15k · streaming...

▽ History                                   [section header, collapsed]
    ▽ Status Bar Polish (2h ago)            82k/128k · idle
        └─ ↓ Compacted 25k (turn 5)
    ▽ Token Counter Tests (yesterday)       archived
```

### Tree Item Types

```typescript
type TreeItem =
  | SectionHeader // "Active", "History"
  | ConversationItem // Main conversation node
  | CompactionItem // Compaction event
  | SubagentItem; // Subagent node

class SectionHeader extends vscode.TreeItem {
  constructor(
    public readonly section: "active" | "history",
    public readonly count: number,
  ) {
    super(
      section === "active" ? "Active" : "History",
      count > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
  }
}

class ConversationItem extends vscode.TreeItem {
  constructor(public readonly conversation: Conversation) {
    super(conversation.title, vscode.TreeItemCollapsibleState.Expanded);
    this.description = this.formatDescription();
    this.iconPath = this.getIcon();
  }
}

class CompactionItem extends vscode.TreeItem {
  constructor(public readonly event: CompactionEvent) {
    super(
      `↓ Compacted ${formatTokens(event.freedTokens)}`,
      vscode.TreeItemCollapsibleState.None,
    );
    this.description = `turn ${event.turnNumber}`;
    this.iconPath = new vscode.ThemeIcon("fold-down");
  }
}

class SubagentItem extends vscode.TreeItem {
  constructor(public readonly subagent: Subagent) {
    super(subagent.name, vscode.TreeItemCollapsibleState.None);
    this.description = formatTokens(subagent.tokens.input);
    this.iconPath = this.getIcon();
  }
}
```

## Retention & Scoping

### Retention Policy

1. **Active conversations** — Always visible, never auto-archived
2. **Idle conversations** — Move to History after 5 minutes of inactivity
3. **Archived conversations** — Keep for 7 days (matches persistence TTL)
4. **Manual trim** — User can clear conversations not related to current workspace

### Workspace Scoping

To determine if a conversation is "related to current workspace":

1. **File mentions** — If the conversation mentions files in the workspace
2. **Workspace folder** — Track which workspace folder was active when conversation started
3. **Explicit association** — User can pin/unpin conversations to workspace

### Trim Button Behavior

```
[Trim History] button in tree view header
  → Shows confirmation: "Remove 5 conversations not related to this workspace?"
  → Removes conversations where:
     - workspaceFolder !== current workspace
     - No file mentions in current workspace
     - Status is 'archived'
```

## Migration Path

### Phase 1: Add Conversation Layer (non-breaking)

1. Create `ConversationManager` that wraps `TokenStatusBar`
2. Build `Conversation` objects from existing `AgentEntry` data
3. Update `AgentTreeDataProvider` to use new tree item types
4. Keep `AgentEntry` and `TokenStatusBar` unchanged

### Phase 2: Persist Conversations

1. Add `CONVERSATION_STORE` to persistence layer
2. Store conversation metadata (title, compaction events, workspace)
3. Restore conversations on VS Code restart

### Phase 3: Full Migration

1. Move token tracking from `AgentEntry` to `Conversation`
2. Simplify `AgentEntry` to just track streaming state
3. Remove redundant fields from `AgentEntry`

## Open Questions

1. **Subagent nesting** — Should subagents that spawn their own subagents be nested? (Probably yes, but adds complexity)

2. **Compaction event granularity** — Should we show each compaction separately or aggregate? (Start with separate, can aggregate later)

3. **History section threshold** — How long before a conversation moves to History? (5 minutes of inactivity seems reasonable)

4. **Workspace detection** — How do we reliably detect which workspace a conversation belongs to? (Start with active workspace folder at conversation start)

## Implementation Notes

### Backward Compatibility

- Existing `AgentEntry` data can be converted to `Conversation` on the fly
- No breaking changes to `TokenStatusBar` API in Phase 1
- Persistence format is additive (new store, old stores still work)

### Performance Considerations

- Tree refresh should be O(conversations) not O(agents)
- Compaction events are append-only, no need to recompute
- History section can be lazily loaded

### Testing Strategy

- Unit tests for `ConversationManager` conversion logic
- Integration tests for tree rendering with mock data
- Visual regression tests for tree appearance
