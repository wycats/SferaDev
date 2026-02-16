# Sidebar as Conversation Lifecycle UI

**Source**: User insight during activity tree property testing (2026-02-15)

## Core Insight

The sidebar should communicate the **lifecycle of a long conversation** — building momentum, approaching summarization, rebuilding context after compaction. The compaction event is a **boundary between eras** of the conversation, not just a system event.

## User Questions the Sidebar Should Answer

### Before Summarization

1. How close am I to summarization?
2. How much do different messages contribute to advancing towards it?
3. What's my current token budget utilization?

### After Summarization

1. "Btw summarization happened recently" — make it visible
2. Characterization of what was summarized (our infrastructure could provide this)
3. New token budget after compaction

## Mental Model

A conversation picks up steam, builds towards summarization, then has to rebuild context. The compaction event is a visible, meaningful transition that users notice because compaction loses details noticeably.

## Why This Matters

> "I would like to say this is 'in the weeds' and most people don't need to care, but the implications of the context budget are profound and even fairly regular users want to understand it."

## Naming

"Context window" is the technical term but doesn't feel like the right user-facing concept. We need a term that matches the vibe — something like "era" or "session" or "chapter" of the conversation. Should investigate how VS Code is evolving to communicate this concept.

## Related Ideas

- [Interactive Summarization UI](./sidebar-interactive-summarization.md)
- The compaction entry in the tree is a boundary marker between these eras
