# Activity Tree: Property-Based UI Specification

## Philosophy

The agent tree's activity log is a **visual narrative** of a conversation. Users think:
"I asked X, and here's everything the AI did in response." The tree must faithfully
reflect this mental model regardless of what event sequence the system produces.

This document specifies the tree's behavior as **falsifiable properties** — invariants
that must hold for _every_ valid event sequence. We test these with a grammar-based
generator that produces realistic event streams and a pure `buildTree` function that
converts them into an ASCII-inspectable tree structure.

## Design Goals

1. **User messages are the organizing principle.** Every AI response and tool
   continuation is nested under the user message that initiated it. The user never
   sees orphaned AI responses floating at the top level (unless they truly precede
   any user message — a degenerate edge case).

2. **Tool loops are visible but subordinate.** When the AI calls tools and gets
   results back, the tool continuation appears as a sibling of the AI response
   inside the same user message group. The tools listed on a tool continuation
   come from the AI response that _requested_ them (the immediately preceding
   AI response in the group).

3. **Chronological fidelity.** Within a group, children appear in the order they
   happened. Across groups, the tree is reverse-chronological (newest first).
   The user reads top-to-bottom as "most recent conversation first."

4. **Windowing preserves group atomicity.** The 20-message window never splits a
   user message from its children. If a user message is visible, ALL of its AI
   responses and tool continuations are visible. If it's in history, all of them are.

5. **Noise entries (compaction, errors) are contextual.** They appear at the top
   level in their chronological position but don't count toward the window limit.
   They age out with their neighbors — they don't float forward or backward.

## The Tree Structure

### What the user sees

```
▼ 👤 "Can you investigate the bug..."              #5 · +0.3k
    ├─ $(chat-sparkle) Read the error logs         #5 · read_file · +0.5k
    ├─ 🔧 read_file                                #6 · +0.2k
    ├─ $(chat-sparkle) Found the issue             #6 · grep_search · +0.8k
    ├─ 🔧 grep_search                              #7 · +0.3k
    └─ $(chat-sparkle) Fixed the bug               #7 · replace_string_in_file · +1.2k
▼ 👤 "Now add tests for it"                        #3 · +0.2k
    ├─ $(chat-sparkle) Created test file           #3 · create_file · +1.0k
    └─ $(chat-sparkle) Tests passing               #4 · run_in_terminal · +0.4k
├─ $(fold-down) Compacted 30k
▼ 👤 "Start by reading the codebase"               #1 · +0.1k
    └─ $(chat-sparkle) Analyzed the structure      #1 · +0.6k
└─ ▸ History (8 earlier entries)
```

### Node types

| Kind                | Level  | Collapsible | Children                       |
| ------------------- | ------ | ----------- | ------------------------------ |
| `user-message`      | top    | yes         | ai-response, tool-continuation |
| `ai-response`       | nested | no\*        | (subagents, future)            |
| `tool-continuation` | nested | no          | —                              |
| `compaction`        | top    | no          | —                              |
| `error`             | top    | no          | —                              |
| `history`           | top    | yes         | (older entries)                |

\*AI responses may become collapsible when subagent nesting is added.

## Event Grammar

Valid event sequences follow this grammar. The generator produces only
sequences that conform to it.

```
ConversationStream ::= Noise* UserMessageGroup+ Noise*
UserMessageGroup   ::= ActualUserMessage Noise* Exchange+
Exchange           ::= AIResponse Noise* ToolLoop?
ToolLoop           ::= ToolContinuation Noise* Exchange
Noise              ::= CompactionEntry | ErrorEntry

ActualUserMessage  ::= UserMessageEntry { isToolContinuation: false }
ToolContinuation   ::= UserMessageEntry { isToolContinuation: true }
AIResponse         ::= AIResponseEntry
```

Key constraints the grammar encodes:

- Every conversation starts with an actual user message (after optional noise)
- Every user message group has at least one AI response
- Tool continuations always follow an AI response (they carry tool results back)
- Tool loops are recursive: TC → AI → TC → AI → ...
- Noise (compaction, errors) can appear between any two entries

## Properties (Oracle)

### P1: Top-level containment

> Every top-level node is `user-message`, `compaction`, `error`, or `history`.
> AI responses and tool continuations NEVER appear at the top level.

```
COUNTEREXAMPLE if violated:

  Input: U(1) → A(1)

  Got:
    $(chat-sparkle) Response #1          ← VIOLATION: ai-response at top level
    👤 Message #1
```

### P2: Nesting depth

> User-message children are only `ai-response` or `tool-continuation`.
> The tree is exactly 2 levels deep (user messages → children). No deeper nesting.

### P3: Tool continuation placement

> A tool continuation is never the first child of a user message group.
> There must be at least one ai-response before any tool-continuation in a group.

```
COUNTEREXAMPLE if violated:

  Input: U(1) → TC(2) → A(2)

  Got:
    ▼ 👤 Message #1
        ├─ 🔧 Tools #2                    ← VIOLATION: TC before any AI response
        └─ $(chat-sparkle) Response #2
```

### P4: Tool provenance

> The `tools` array on a tool-continuation equals the `toolsUsed` array of the
> immediately preceding ai-response in the same group.

```
COUNTEREXAMPLE if violated:

  Input: U(1) → A(1, tools=[read_file, grep]) → TC(2) → A(2, tools=[run_terminal])

  Got:
    ▼ 👤 Message #1
        ├─ $(chat-sparkle) Response #1     · read_file, grep
        ├─ 🔧 run_terminal                 ← VIOLATION: should be read_file, grep
        └─ $(chat-sparkle) Response #2     · run_terminal
```

### P5: Reverse-chronological top level

> Top-level user-message nodes appear in descending order of their
> `sequenceNumber`. Compaction and error nodes appear in their chronological
> position relative to the user messages.

### P6: Chronological children

> Children within a user-message group appear in ascending chronological order
> (earliest first). Specifically, sequence numbers are non-decreasing.

### P7: Partition completeness

> Every entry in the input appears in exactly one of: windowed output, or
> history output. No entry is lost or duplicated.

### P8: Exclusive grouping

> Every AI response and tool continuation in the windowed output is a child
> of exactly one user-message group. No entry appears in two groups.

### P9: Group boundary rule

> A new group starts if and only if the entry is a `user-message` with
> `isToolContinuation !== true`. Tool continuations and AI responses
> accumulate into the current group.

### P10: Window limit

> The windowed output contains at most 20 actual user messages
> (entries where `type === "user-message" && !isToolContinuation`).

### P11: History existence

> If the input contains more than 20 actual user messages, the output
> includes a history node. If ≤20, no history node exists.

### P12: Group atomicity

> If a user message is in the windowed output, ALL entries that belong to
> its group (AI responses, tool continuations) are also in the windowed output.
> Conversely, if a user message is in history, all its group members are too.
> No group is ever split across the window/history boundary.

```
COUNTEREXAMPLE if violated:

  Input: U(1) → A(1) → U(2) → A(2)    [window=1]

  Got:
    windowed: [U(2), A(2), A(1)]        ← VIOLATION: A(1) belongs to U(1)'s group
    history:  [U(1)]                     ← but U(1) is in history without its A(1)
```

### P13: Compaction/error aging

> Compaction and error entries in the windowed output are chronologically
> positioned between windowed user-message groups. They never appear
> "after" (chronologically before) the oldest windowed user message.

## Test Architecture

```
ActivityLogEntry[]                    ← generated by grammar-based Arbitrary
        │
        ▼
  windowActivityLog()                 ← pure function (existing)
        │
        ├─► windowed: ActivityLogEntry[]
        │         │
        │         ▼
        │   groupByUserMessage()      ← pure function (to extract)
        │         │
        │         ▼
        │   TreeNode[]                ← pure data, no vscode dependency
        │
        └─► history: ActivityLogEntry[]
                  │
                  ▼
            TreeNode[]

Properties check TreeNode[] structure against the invariants above.
Counterexamples render as ASCII trees for visual inspection.
```

## Generator Parameters

| Parameter               | Range    | Distribution                          |
| ----------------------- | -------- | ------------------------------------- |
| Actual user messages    | 1–40     | Biased toward 15–25 (window boundary) |
| Tool loops per exchange | 0–5      | Geometric(p=0.4)                      |
| Tools per AI response   | 0–6      | Geometric(p=0.5)                      |
| Compaction events       | 0–3      | Uniform                               |
| Error events            | 0–3      | Uniform                               |
| Has preview text        | boolean  | 70% true                              |
| Has characterization    | boolean  | 80% true                              |
| Token contribution      | 100–5000 | Log-normal                            |
| Sequence number gaps    | 0–2      | Rare (5% chance of gap)               |

## Regression Seeds

Explicit test cases that exercise known edge cases:

1. **Empty log** — `[]`
2. **Single user message, no tool loop** — `U(1) → A(1)`
3. **Exactly 20 user messages** — window boundary
4. **21 user messages** — first history entry
5. **Deep tool loop** — `U(1) → A(1) → TC(2) → A(2) → TC(3) → A(3) → TC(4) → A(4)`
6. **Multiple user messages with interleaved compaction** — `U(1) → A(1) → C → U(2) → A(2)`
7. **Error between tool loops** — `U(1) → A(1) → E → TC(2) → A(2)`
8. **Compaction as first entry** — `C → U(1) → A(1)`
9. **Error as last entry** — `U(1) → A(1) → E`
10. **AI response with no tools, followed by tool continuation** — tests empty tools propagation
