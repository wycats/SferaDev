---
title: RFC 00073 Conversation-Centric Agent Tree
feature: Unknown
exo:
    tool: exo rfc create
    protocol: 1
---

# RFC 00074: RFC 00073 Conversation-Centric Agent Tree

This document maps every testable requirement in RFC 00073 to falsifiable properties for property-based testing. It defines the SUT, event grammar, generator design, and property set.

## 1. SUT Description

### Functions under test

- `buildTree(log: ActivityLogEntry[]): TreeResult`
- `windowActivityLog(log: ActivityLogEntry[]): { windowed: ActivityLogEntry[]; history: ActivityLogEntry[] }`
- `groupByUserMessage(entries: ActivityLogEntry[]): TreeNode[]`

### Input type

`ActivityLogEntry[]` (chronological, oldest first)

### Output type

`TreeResult`:

```ts
interface TreeResult {
  topLevel: TreeNode[];
  historyEntries: ActivityLogEntry[];
}
```

### Tree node types

```ts
type TreeChild =
  | { kind: "ai-response"; entry: AIResponseEntry; tools: string[] }
  | { kind: "tool-continuation"; entry: UserMessageEntry; tools: string[] }
  | { kind: "error"; entry: ErrorEntry };

type TreeNode =
  | {
      kind: "user-message";
      entry: UserMessageEntry;
      children: TreeChild[];
      hasError: boolean;
    }
  | { kind: "compaction"; entry: CompactionEntry }
  | { kind: "error"; entry: ErrorEntry }
  | { kind: "history"; count: number };
```

### Key type notes

- An "actual user message" is a `UserMessageEntry` where `isToolContinuation !== true`.
- `tool-continuation` nodes are derived from `UserMessageEntry` where `isToolContinuation === true`.
- `hasError` is a derived flag: true iff the user-message group contains any error child.

## 2. Event Grammar

### BNF grammar

```
ConversationStream ::= Noise* UserMessageGroup+ Noise*

UserMessageGroup   ::= ActualUserMessage GroupTail
GroupTail          ::= (Noise* Exchange)+

Exchange           ::= AIResponse Noise* ToolLoop?
ToolLoop           ::= ToolContinuation Noise* Exchange

Noise              ::= CompactionEntry | ErrorEntry

ActualUserMessage  ::= UserMessageEntry { isToolContinuation: false }
ToolContinuation   ::= UserMessageEntry { isToolContinuation: true }
AIResponse         ::= AIResponseEntry
```

### Key constraints encoded by the grammar

- The stream can start with noise; errors and compactions may appear anywhere.
- Every user-message group starts with an actual user message.
- Every group has at least one AI response.
- Tool continuations only appear after an AI response.
- Tool loops are recursive: TC -> AI -> TC -> AI -> ...

### How errors fit

Errors are modeled as `Noise` and can appear anywhere in the stream, including:

- Before any user message (orphan errors).
- Between AI responses and tool continuations within a group.
- Between groups.

This is a requirement: errors are not tied to strict adjacency constraints.

## 3. Generator Design

### Parameters and distributions

- Actual user messages: 1..40, biased toward 15..25 to stress the window boundary.
- AI responses per group: 1..5, geometric(p=0.5).
- Tool loops per group: 0..4, geometric(p=0.4).
- Tools per AI response: 0..6, geometric(p=0.5).
- Compactions: 0..3, uniform.
- Errors: 0..4, uniform.
- Sequence numbers: monotone, with rare gaps (5% chance of +2 to +3 jump).
- Timestamps: monotone, with small jitter.

### Generation process (valid sequences only)

1. Generate `N` actual user messages.
2. For each user message:
   - Emit the user message entry.
   - Emit at least one AI response.
   - Optionally insert noise between any two entries (compaction or error).
   - Generate tool loop(s): after an AI response, optionally emit a tool continuation, then another AI response, repeating.
3. Optionally insert noise before the first user message and after the last group.
4. Ensure the event stream is chronological.

### Noise insertion

- Compaction and errors are injected as `Noise` between any two entries.
- Errors before any user message are allowed.
- Compaction and errors do not affect grouping.

### Shrinking strategy (no seeds)

- Shrink by removing whole groups.
- Shrink by removing noise entries.
- Shrink by reducing tool loops (TC/AI pairs).
- Shrink tool lists on AI responses.
- Shrink timestamps and sequence number gaps.

## 4. Properties

All properties are falsifiable and include a minimal counterexample ASCII tree. "Requirement source" refers to the RFC section or decision statement.

### P1. Top-level node containment

**Requirement source:** Core Principle: User-Message-Centric Grouping; Tree Layout; Decisions: "Error nesting", "Compaction display"

**Formal statement:** In `TreeResult.topLevel`, every node kind is one of `user-message`, `compaction`, `error`, or `history`. `ai-response` and `tool-continuation` never appear as top-level nodes.

**Counterexample:**

```
Got:
  AI#1
  UM#1
```

---

### P2. Child node containment

**Requirement source:** Core Principle; Nesting hierarchy

**Formal statement:** Every child of a `user-message` node is one of `ai-response`, `tool-continuation`, or `error`. No other child kinds appear.

**Counterexample:**

```
Got:
  UM#1
    C
```

---

### P3. Error nesting (grouped errors)

**Requirement source:** "Error nesting and parent inflection"

**Formal statement:** For any error entry that occurs after an actual user message and before the next actual user message, that error must appear as a child of that user-message node, not as top-level.

**Counterexample:**

```
Input stream: UM#1, AI#1, ERR("boom"), UM#2, AI#2

Got:
  ERR("boom")
  UM#2
  UM#1
```

---

### P4. Error parent inflection

**Requirement source:** "Error nesting and parent inflection"

**Formal statement:** A `user-message` node has `hasError === true` iff at least one of its children has kind `error`.

**Counterexample:**

```
Got:
  UM#1 (hasError=false)
    AI#1
    ERR("boom")
```

---

### P5. Orphan error handling

**Requirement source:** "Orphan errors ... remain as standalone top-level nodes"

**Formal statement:** Any error entry that appears before the first actual user message appears as a top-level `error` node, not as a child of any group.

**Counterexample:**

```
Input stream: ERR("boot"), UM#1, AI#1

Got:
  UM#1
    ERR("boot")
```

---

### P6. Tool continuation placement

**Requirement source:** Core Principle; Tool continuation in group; Generator grammar

**Formal statement:** Within a user-message group, the first child is never a `tool-continuation`. There must be at least one `ai-response` before any `tool-continuation` in that group.

**Counterexample:**

```
Got:
  UM#1
    TC#2
    AI#2
```

---

### P7. Tool provenance

**Requirement source:** "Tool continuation display" + grouping rules

**Formal statement:** For any `tool-continuation` child, its `tools` list equals the `toolsUsed` list of the immediately preceding `ai-response` child within the same group.

**Counterexample:**

```
Got:
  UM#1
    AI#1 tools=[read_file,grep_search]
    TC#2 tools=[run_in_terminal]
```

---

### P8. Reverse-chronological ordering (top level)

**Requirement source:** "Activity log order: Reverse chronological"

**Formal statement:** Top-level user-message nodes appear in descending order of their appearance in the input stream (most recent first). Compaction and orphan error nodes are positioned according to their chronological position relative to user-message groups.

**Counterexample:**

```
Input stream: UM#1, AI#1, UM#2, AI#2

Got:
  UM#1
  UM#2
```

---

### P9. Chronological children (within group)

**Requirement source:** "Chronological fidelity"

**Formal statement:** The children of a user-message node appear in the same order as their corresponding entries appear in the input stream.

**Counterexample:**

```
Input stream: UM#1, AI#1, TC#2, AI#2

Got:
  UM#1
    AI#2
    TC#2
    AI#1
```

---

### P10. Partition completeness (windowing)

**Requirement source:** "Windowing: 20-Exchange Rule"

**Formal statement:** For `windowActivityLog`, every input entry appears in exactly one of `windowed` or `history` (not both, not neither).

**Counterexample:**

```
Input: [UM#1, AI#1]

Got:
  windowed: [UM#1]
  history:  []
```

---

### P11. Exclusive grouping (no double membership)

**Requirement source:** Core Principle; Grouping rules

**Formal statement:** Every `ai-response`, `tool-continuation`, and grouped `error` appears as a child of exactly one user-message node in `topLevel`. No entry is duplicated across groups.

**Counterexample:**

```
Got:
  UM#1
    AI#1
  UM#2
    AI#1
```

---

### P12. Group boundary rule

**Requirement source:** "Core Principle: User-Message-Centric Grouping"

**Formal statement:** A new group starts iff the entry is an actual user message (`type === "user-message"` and `isToolContinuation !== true`). Tool continuations and AI responses never start a group.

**Counterexample:**

```
Input stream: UM#1, AI#1, TC#2, AI#2

Got:
  UM#1
    AI#1
  UM#2 (tool continuation used as a group header)
    AI#2
```

---

### P13. Window limit (20 exchanges)

**Requirement source:** "Windowing: The 20-Exchange Rule"

**Formal statement:** `buildTree(log).topLevel` includes at most 20 `user-message` nodes (actual user messages). Compaction and error nodes do not count toward this limit.

**Counterexample:**

```
Got:
  21 user-message nodes at top level
```

---

### P14. History existence

**Requirement source:** "Windowing: The 20-Exchange Rule"

**Formal statement:** A `history` node exists in `topLevel` iff the input contains more than 20 actual user messages. If there are 20 or fewer, no history node exists.

**Counterexample:**

```
Input: 21 actual user messages

Got:
  no history node
```

---

### P15. Group atomicity across window/history

**Requirement source:** "Windowing preserves group atomicity"

**Formal statement:** No group is split across `windowed` and `history`. If a user message is in `windowed`, all entries in its group are in `windowed`. If it is in `history`, all entries in its group are in `history`.

**Counterexample:**

```
Input stream: UM#1, AI#1, UM#2, AI#2   (window size = 1)

Got:
  windowed: UM#2, AI#2, AI#1
  history:  UM#1
```

---

### P16. Compaction is always top-level

**Requirement source:** "Compaction as Era Boundary"

**Formal statement:** Every compaction entry appears as a top-level `compaction` node and never as a child of a user-message group.

**Counterexample:**

```
Got:
  UM#1
    C
```

---

### P17. Compaction aging and placement

**Requirement source:** "Compaction as Era Boundary"; "Windowing: Compaction doesn't count toward 20"

**Formal statement:** In the windowed view, compaction nodes appear in the same chronological position relative to windowed user-message groups; they do not move earlier or later across the window boundary.

**Counterexample:**

```
Input stream: UM#1, AI#1, C, UM#2, AI#2  (window size includes both groups)

Got:
  UM#2
  UM#1
  C
```

---

### P18. Compaction does not count toward window size

**Requirement source:** "Compaction counting: Doesn't count toward 20"

**Formal statement:** For any log with `N` actual user messages, the number of `user-message` nodes in `topLevel` is `min(N, 20)` regardless of how many compaction entries exist.

**Counterexample:**

```
Input: 20 user messages + 3 compactions

Got:
  only 19 user-message nodes in topLevel
```

## 5. What NOT to Test

Out of scope for this strategy:

- VS Code TreeItem rendering or icon selection.
- Visual formatting and description strings (token formatting, labels).
- Subagent nesting and subagent tree behaviors.
- Response state machine transitions.
- Persistence and storage TTL.
- Workspace scoping, trimming, or filtering behavior.
- UI-specific timing (characterization grace window, streaming spinner).

These are separate concerns and should be tested with targeted unit or integration tests.
