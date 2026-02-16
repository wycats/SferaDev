---
title: Conversation-Centric Agent Tree
feature: Unknown
exo:
  tool: exo rfc create
  protocol: 1
---

# RFC 00073: Conversation-Centric Agent Tree

## Status

Stage 1 — Proposal (Phase 4 in progress)

## Summary

Redesign the agent tree with **user-message-centric grouping**: each user message is a collapsible
parent containing all AI responses, tool calls, and tool continuations that followed — until the
next user message. Conversations are the primary entity; user messages organize the activity within.

## Motivation

### Current Problems

1. **AgentEntry conflates identity and display** — An agent is both an identity (conversationId) and a display unit, making it awkward to show history or group related activity.

2. **Deletion vs archival** — Agents are removed after 5 newer completions, losing history. Users can't see what they were working on earlier.

3. **Compaction is transient** — Summarization events fade after 2 exchanges, but they're meaningful milestones in a conversation's lifecycle.

4. **No workspace scoping** — All conversations are shown regardless of relevance to current work.

5. **No message-level visibility** — Users can't see what happened at each exchange, making it hard to understand conversation flow.

### User Mental Model

Users think in terms of **conversations** — discrete sessions where they're working on a specific task. Each conversation is an **activity log**: a sequence of user messages, AI responses, compaction events, errors, and subagent invocations. The tree should reflect this chronological narrative.

## Design

### Core Principle: User-Message-Centric Grouping

Each conversation's children are **user message groups** in reverse-chronological order (newest first).
A user message group contains everything that happened in response to that user message:
AI responses, tool calls, tool result continuations, and follow-up AI responses — all nested
under the original user message that initiated the exchange.

This reflects how users think about conversations: "I asked X, and here's everything the AI did."

**Entry types within a user message group:**

- **AIResponse** — The AI's response. Shows characterization, tools used, and token contribution.
- **ToolContinuation** — Tool results sent back to the AI. Shows which tools returned results.
- **Error** — A failed request or stream error that occurred during this exchange.

**Standalone entry types (not nested under user messages):**

- **CompactionEvent** — An era boundary marking where summarization reduced the context. Compaction
  is not "part of" any user message group — it's a transition between eras of the conversation.

**Error nesting and parent inflection:**

Errors are children of the user message group that was being processed when the error occurred.
When a group contains an error, the parent user message node is visually inflected:

- The `$(feedback)` icon is tinted with `errorForeground` (red) instead of `descriptionForeground`
- The description appends `· ⚠ error` (e.g., `#3 · +200 · ⚠ error`)

This provides both a color signal and a text signal (accessibility). The inflection does NOT
replace the icon or make the node look like a pure error — the user message is still a user
message, it just has a problem inside.

Orphan errors (errors that occur before any user message in the log) remain as standalone
top-level nodes. This is a degenerate edge case.

### Tree Layout

**Top level** — Active conversations appear directly at the root. No "Active" section header.

```
▼ Login Bug Fix                                   45k/128k · 35%
    ▼ 👤 "Can you refactor the auth..."           #5 · +0.3k
        ├─ $(chat-sparkle) Investigated issue     #5 · read_file, grep_search · +0.8k
        ├─ 🔧 read_file, grep_search              #5 · +0.4k
        ├─ $(chat-sparkle) Refactored auth        #5 · replace_string_in_file · +1.2k
        ├─ 🔧 replace_string_in_file              #5 · +0.2k
        └─ $(chat-sparkle) Verified the fix       #5 · run_in_terminal · +0.3k
    ▼ 👤 "The session handling seems off"         #4 · +0.2k
        └─ $(chat-sparkle) Analyzed session flow  #4 · read_file · +0.6k
    ├─ $(fold-down) Compacted 30k                          ← era boundary
    └─ ▸ History (12 earlier entries)
▼ API Refactor                                    82k/128k · streaming...
    ▼ 👤 "Extract the shared logic"               #3 · +0.4k
        └─ $(loading~spin) streaming...
    └─ ▸ History (3 earlier entries)
▽ History
    ▽ Status Bar Polish (2h ago)                  idle
    ▽ Token Counter Tests (yesterday)             archived
```

**Children of a conversation** — Up to 20 recent user message groups (exchanges), plus compaction/error entries. Older entries collapse into a nested "History" node.

**Subagents nest under the AI response that spawned them:**

```
▼ 👤 "Refactor the auth middleware"               #5 · +0.3k
    ▼ $(chat-sparkle) Refactored auth             #5 · +1.2k
        ▼ recon                                   8k · complete
            └─ recon-worker                       3k · complete
        └─ execute                                15k · complete
```

### Icons

| Entry Type            | Icon                      | Notes                       |
| --------------------- | ------------------------- | --------------------------- |
| User message          | `$(feedback)`             | Speech bubble (collapsible) |
| Tool continuation     | `$(tools)`                | Tool results returned to AI |
| AI response           | `$(chat-sparkle)`         | Chat bubble with AI sparkle |
| AI response (error)   | `$(chat-sparkle-error)`   | Error variant               |
| AI response (warning) | `$(chat-sparkle-warning)` | Warning variant             |
| AI streaming          | `$(loading~spin)`         | Animated spinner            |
| Compaction            | `$(fold-down)`            | Collapse/fold indicator     |
| History               | `$(history)`              | Clock/history icon          |

### Windowing: The 20-Exchange Rule

Each conversation shows at most **20 recent user message groups** (exchanges). Compaction entries
don't count toward this limit but do age out chronologically. Errors are children of their
user message group and are included/excluded with the group.

Older entries live in a nested **History** node per conversation. This keeps the tree compact
while preserving full history.

### Compaction as Era Boundary

Compaction events are **era boundaries** — they mark where the system summarized older context
to make room for new exchanges. They are NOT children of any user message group. They appear
as standalone nodes between groups, visually separating the conversation into eras.

This reflects the user's experience: a conversation builds momentum, approaches a summarization
threshold, compacts, and then rebuilds context in a new era. The compaction node communicates
"here's where the system summarized" and how many tokens were freed.

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
type ActivityLogEntry =
  | UserMessageEntry
  | AIResponseEntry
  | CompactionEntry
  | ErrorEntry;

/** A user's message to the AI */
interface UserMessageEntry {
  type: "user-message";
  sequenceNumber: number; // Groups user message + AI response
  timestamp: number;

  /** Token contribution to context */
  tokenContribution?: number;

  /** Preview of the message content (truncated to ~80 chars) */
  preview?: string;

  /** True if this entry was triggered by tool results, not a new user message */
  isToolContinuation?: boolean;
}

/** The AI's response to a user message */
interface AIResponseEntry {
  type: "ai-response";
  sequenceNumber: number; // Groups user message + AI response
  timestamp: number;

  /** Response lifecycle state */
  state: ResponseState;

  /** Short characterization of what happened (from Copilot model) */
  characterization?: string;

  /** Token contribution to context (response size) */
  tokenContribution: number;

  /** IDs of subagents spawned during this response */
  subagentIds: string[];

  /** Names of tools called during this response (e.g., ["read_file", "grep_search"]) */
  toolsUsed?: string[];
}

/** AI response lifecycle states */
type ResponseState =
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

### Response State Machine

AI responses follow a well-defined lifecycle with explicit state transitions:

```
                    ┌─────────────┐
                    │  streaming  │ ◄── Response created when agent starts streaming
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

| From                       | To                         | Trigger                                                  |
| -------------------------- | -------------------------- | -------------------------------------------------------- |
| (none)                     | `streaming`                | Agent starts streaming                                   |
| `streaming`                | `pending-characterization` | Stream completes successfully                            |
| `streaming`                | `interrupted`              | Session ends while streaming (restored from persistence) |
| `streaming`                | (error entry)              | Stream error occurs                                      |
| `pending-characterization` | `characterized`            | Characterization arrives                                 |
| `pending-characterization` | `uncharacterized`          | 10-second timeout expires                                |

**Key Invariants:**

1. At most one AI response per conversation can be in `streaming` state
2. A user message entry is created when the request starts; an AI response entry is created when streaming begins
3. Responses restored from persistence are never `streaming` — they become `interrupted` if they were streaming when persisted
4. The 10-second characterization window is a view concern, not persisted state
5. Windowing (showing last 20 user message groups) is purely a view concern

**Display Mapping:**

| State                      | Icon              | Description                          |
| -------------------------- | ----------------- | ------------------------------------ |
| `streaming`                | `$(loading~spin)` | "streaming..."                       |
| `pending-characterization` | `$(sync~spin)`    | "summarizing..." (within 10s window) |
| `characterized`            | `$(chat-sparkle)` | Shows characterization text          |
| `uncharacterized`          | `$(chat-sparkle)` | "#N · +Xk"                           |
| `interrupted`              | `$(warning)`      | "#N (interrupted)"                   |

### Tree Item Types

| Type                   | Description                                      | Icon              | Collapsible  |
| ---------------------- | ------------------------------------------------ | ----------------- | ------------ |
| `ConversationItem`     | Top-level conversation                           | model-dependent   | Yes          |
| `UserMessageItem`      | User's message (groups all responses underneath) | `$(feedback)`     | Yes          |
| `ToolContinuationItem` | Tool results sent back to AI                     | `$(tools)`        | No           |
| `AIResponseItem`       | Agent's response                                 | `$(chat-sparkle)` | If subagents |
| `CompactionItem`       | Compaction event                                 | `$(fold-down)`    | No           |
| `ErrorItem`            | Failed response or stream error (child of group) | `$(error)`        | No           |
| `SubagentItem`         | Subagent node (nested under response)            | status-dependent  | If children  |
| `HistoryItem`          | "History (N earlier)" collapsible                | `$(history)`      | Yes          |
| `SectionHeader`        | "History" at top level                           | `$(archive)`      | Yes          |

**Nesting hierarchy:**

```
ConversationItem
├─ UserMessageItem (collapsible parent for each actual user message)
│   ├─ AIResponseItem (may have subagents as children)
│   │   └─ SubagentItem
│   ├─ ToolContinuationItem (tool results)
│   ├─ AIResponseItem (follow-up response)
│   ├─ ErrorItem (error during this exchange)
│   └─ ... (continues until next user message)
├─ CompactionItem (era boundary, standalone between groups)
└─ HistoryItem
```

### Response Characterization

Each AI response gets a short characterization (e.g., "Refactored auth middleware", "Added unit tests
for parser") generated by a free Copilot model (gpt-4o-mini). This follows the same pattern
as `TitleGenerator`.

**Data source**: The `StreamAdapter` already accumulates all response parts unconditionally
via `accumulatedParts` (used for `getFinalMessage()`). The chat handler also accumulates
`accumulatedText` (all `LanguageModelTextPart.value` concatenated). Either can feed
characterization without new collection overhead.

**Timing**: Characterization runs after each response completes (stream done). It's asynchronous
and non-blocking — the tree shows the response with token counts immediately, then updates the
label when the characterization arrives.

**Fallback**: If characterization fails or hasn't arrived yet, the response shows as
"#N · +Xk" (sequence number and token contribution only). The first user message preview is also available
from `AgentEntry.firstUserMessagePreview`.

### Post-Restart Grace Period

When VS Code restarts, previous-session conversations should not immediately demote to
History. Instead:

- Previous-session conversations remain **active** at the top level
- They stay active until **a few minutes after the first new exchange** in the current session
- This prevents the jarring experience of all conversations disappearing on restart
- If no new exchanges happen, previous-session conversations remain active indefinitely
  (the user is just reading, not actively chatting)

### Subagent Nesting

Subagents nest under the **AI response that spawned them**, which itself nests under the
user message that initiated the exchange. This creates a natural hierarchy:

```
▼ 👤 "Refactor the auth middleware"               #5 · +0.3k
    ▼ $(chat-sparkle) Refactored auth             #5 · +1.2k
        ▼ recon                                   8k · complete
            └─ recon-worker                       3k · complete
        └─ execute                                15k · complete
```

Subagent history stays nested — it never floats up to the top-level History section.
The top-level History only collects idle/archived **top-level conversations**.

### Decisions

| Question                      | Decision                    | Rationale                                                              |
| ----------------------------- | --------------------------- | ---------------------------------------------------------------------- |
| **Section headers**           | No "Active"; "History" only | Active conversations at root, less clutter                             |
| **User message grouping**     | Collapsible parent          | Groups all responses/tools under the user message that triggered them  |
| **Subagent nesting**          | Under spawning AI response  | Natural hierarchy; shows what triggered subagents                      |
| **Compaction display**        | Standalone (era boundary)   | Marks where summarization reduced context; separates conversation eras |
| **Active → History**          | 5 minutes idle              | Long enough for tab switches, short enough to be meaningful            |
| **Post-restart**              | Grace period                | Stay active until minutes after first new exchange in new session      |
| **Activity log windowing**    | 20 user message groups      | Keeps tree compact; counts exchanges not individual entries            |
| **Activity log order**        | Reverse chronological       | Newest first, matches mental model of "what just happened"             |
| **Error nesting**             | Children of user msg group  | Errors belong to the exchange they occurred during; inflect parent     |
| **Compaction counting**       | Doesn't count toward 20     | Era boundaries shouldn't push off user message groups                  |
| **Response characterization** | Via Copilot model           | Rich labels without user cost; same pattern as TitleGenerator          |
| **Characterization data**     | From accumulatedText        | Already stored unconditionally for error reporting                     |
| **Characterization window**   | 10 seconds                  | Show "summarizing..." spinner for recently completed responses         |
| **Subagent history**          | Stays nested under parent   | Never floats to top-level History                                      |
| **Workspace scoping**         | Track at start              | Simple, reliable; can enhance with file-mention detection later        |
| **Response creation timing**  | When streaming starts       | Show response immediately when agent starts streaming                  |
| **Restored streaming**        | Mark as "interrupted"       | Responses that were streaming when session ended get special state     |
| **Window size**               | Fixed at 20 exchanges       | Start simple; can make configurable later if needed                    |
| **Tool continuation display** | Shows tool names            | User sees which tools returned results                                 |
| **User message icon**         | `$(feedback)`               | Speech bubble indicates user input (collapsible)                       |
| **Tool continuation icon**    | `$(tools)`                  | Tool icon indicates tool results                                       |
| **AI response icon**          | `$(chat-sparkle)`           | Chat sparkle indicates AI output                                       |

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
- Tracks compaction events (cumulative summarization + per-exchange context management)
- Builds nested subagent hierarchy with cycle protection

### Phase 2: Tree Items & Activity Log ✅

Rewrote `AgentTreeDataProvider` using `ConversationManager` as data source:

- ✅ Message-level `UserMessageItem` and `AIResponseItem` tree items with activity log
- ✅ `CompactionItem` and `ErrorItem` log entries
- ✅ `SubagentItem` nested under spawning response
- ✅ Per-conversation `HistoryItem` for older entries (windowing)
- ✅ Reverse chronological order (newest first)
- ✅ Response characterization via Copilot model
- ✅ Persistence to memento storage
- ✅ Restoration on VS Code reload
- ✅ Token contribution display for user messages and AI responses
- ✅ Tool continuation detection (`isToolContinuation` flag)

### Phase 2.5: Response State Machine ✅

Refactored response tracking to use explicit state machine:

- ✅ Replace `streaming: boolean` with `state: AIResponseState`
- ✅ Implement state transitions in `ConversationManager`
- ✅ Handle `interrupted` state for responses restored from persistence
- ✅ Clean up ad-hoc streaming/finalization logic
- ✅ Update tree items to use state-based display
- ✅ Sync agent turnCount with activity log on restoration (single source of truth)

### Phase 3: User Message Previews & Tool Tracking ✅

Enhance activity log entries with content summaries:

- ✅ **Capture user message preview** — Extract last user message text from provider's `messages` array
- ✅ **Add preview capture API** — `ConversationManager.setUserMessagePreview(conversationId, sequenceNumber, preview)`
- ✅ **Truncate previews** — ~80 chars with ellipsis for display
- ✅ **Track tools used** — Populate `AIResponseEntry.toolsUsed` with tool names called during response
- ✅ **Update display** — Show preview in `UserMessageItem` label, tools in `AIResponseItem` description

### Phase 4: User-Message-Centric Nesting (current)

Reorganize tree so each **actual user message** is a collapsible parent containing all
subsequent activity until the next user message:

1. **Make `UserMessageItem` collapsible** — Only for actual user messages (not tool continuations)
2. **Group by user message** — All entries after a user message nest under it until the next user message
3. **Tool continuations as children** — Show tool names, nest under parent user message
4. **AI responses as children** — Multiple responses nest under same user message
5. **Errors as children** — Errors nest under the user message group they occurred during, with parent inflection (red-tinted icon + `· ⚠ error` in description)
6. **Compaction as era boundary** — Compaction stays standalone between groups, marking context transitions
7. **Preserve subagent nesting** — Subagents nest under AIResponseItem, which nests under UserMessageItem
8. **Update windowing** — Count user message groups (exchanges), not individual entries

Example tree structure after Phase 4:

```
▼ 👤 "How do I fix the bug..."              #5 · +0.3k
    ├─ $(chat-sparkle) Investigated issue   #5 · read_file, grep_search · +0.8k
    ├─ 🔧 read_file, grep_search            #5 · +0.4k
    └─ $(chat-sparkle) Fixed the bug        #5 · replace_string_in_file · +1.2k
▼ 👤 "Deploy to production"                 #4 · +0.2k · ⚠ error
    ├─ $(chat-sparkle) Starting deploy      #4 · run_in_terminal · +0.3k
    └─ $(error) Connection timeout
├─ $(fold-down) Compacted 30k
▼ 👤 "Now test it"                          #3 · +0.2k
    └─ $(loading~spin) streaming...
```

### Phase 5: Polish & Edge Cases

1. Idle timer (5 minutes → move to History section)
2. Post-restart grace period
3. Environment-aware title generation refinement

### Phase 6: Workspace Scoping & Trim

1. Track `workspaceFolder` when conversation starts
2. Add "Trim History" command and button
3. Filter tree by workspace (optional setting)

## Migration

- Existing `AgentEntry` data converts to `Conversation` on the fly
- No breaking changes to `TokenStatusBar` API
- Persistence format is additive (new store alongside existing stores)
- `LastSessionTreeItem` → absorbed by post-restart grace period logic

## Existing Infrastructure (for response characterization)

The following data is already captured unconditionally during streaming:

1. **`StreamAdapter.accumulatedParts`** — Every emitted `LanguageModelResponsePart` accumulated via `adapt()`. Available via `getFinalMessage()`.
2. **`accumulatedText`** in `openresponses-chat.ts` — All `LanguageModelTextPart.value` concatenated during streaming (line ~644). Used for diagnostics.
3. **`investigationHandle?.recorder?.recordEvent()`** — Every raw SSE event recorded for the investigation logger.

Response characterization can piggyback on `accumulatedText` without adding new collection overhead.

## Open Questions

1. ~~Compaction event detail level~~ → Resolved: separate log entries with freed token counts

2. **Multi-workspace** — How to handle conversations that span multiple workspace folders?

3. **Search/filter** — Should we add search functionality to find old conversations?

4. ~~Characterization phasing~~ → Resolved: included in Phase 2 (small effort, polished labels from day one)

## References

- [Property Testing Strategy](./00073-conversation-centric-agent-tree.property-strategy.md) — Verification plan mapping RFC requirements to testable properties
- [docs/design/conversation-tree-model.md](../../design/conversation-tree-model.md) — Initial design exploration
- RFC 00033 — Agent identity tracking (conversationId infrastructure)
- `src/title-generator.ts` — Pattern for free-model characterization
- `src/provider/stream-adapter.ts` — `accumulatedParts` / `getFinalMessage()` for response data
- `src/provider/openresponses-chat.ts` — `accumulatedText` captured during streaming
