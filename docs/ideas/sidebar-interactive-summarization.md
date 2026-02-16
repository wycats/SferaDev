# Sidebar as Interactive Summarization UI

**Source**: User insight during activity tree property testing (2026-02-15)

## Core Idea

Evolve the sidebar from a passive display into a **proactive summarization UI** where users can interact with their conversation history.

## Capabilities (Progressive)

### Phase 1: View Messages

- Click a message in the sidebar to see its full content
- Easy, should do this regardless

### Phase 2: Re-present to Agent

- Select specific messages and re-present them to the agent
- Useful for "hey, remember when we discussed X?"

### Phase 3: Proactive Summarization

- User selects messages they think aren't important
- Ask for them to be summarized (need to design the approach)
- Summarized version replaces originals in the next session
- Or: user writes their own summary to replace selected messages

## Prerequisites

1. **Model provider control**: Our ability to control the flow by being a model provider (without also needing to be a chat participant, probably)
2. **UI foundation**: The sidebar work we've been doing — necessary to give the user a visceral sense of the conversation and a way to use direct interactions to drive summarization

## Why This Matters

This transforms the sidebar from "nice to have visibility" into a **tool for managing conversation quality** — the user becomes an active participant in deciding what context matters.

## Related Ideas

- [Conversation Lifecycle UI](./sidebar-conversation-lifecycle.md)
- RFC 00073 (Activity Tree) provides the foundation
