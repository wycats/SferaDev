---
title: Tool History Architecture
stage: 0
feature: tool-history
exo:
  tool: exo rfc create
  protocol: 1
---

# RFC 026: Tool History Architecture

**Status:** Stage 0 (Draft)  
**Created:** 2026-01-31  
**Related:** RFC 013 (Tool Call Truncation), RFC 00024 (Native Tool History Migration), RFC 00025 (Unified Tool History Architecture)

## Summary

Consolidate tool history handling into a single architecture that supports:

- Truncation of tool call history for context management
- Migration to native `function_call` input items when the Gateway supports them
- A unified `ToolHistoryManager` with a strategy pattern for rendering
- Clear implementation phases and rollout status

The goal is to preserve recent tool call pairs, compress older history, and remove divergence between translation and truncation logic while remaining compatible with current Gateway constraints.

## Motivation

### The Gateway Gap

OpenResponses allows `function_call` items in input, but the Vercel AI Gateway currently rejects them with `400 Invalid input` (as of 2026-01-31). This forces the extension to embed tool results as plain text and omit tool calls to avoid mimicry risks.

### Problems Today

1. **Context Growth:** Tool call history consumes significant tokens as sessions grow.
2. **Lost Semantics:** Text-embedded tool calls lose structure and enable less precise truncation.
3. **Divergence:** Translation logic and truncation logic use different formatting paths.
4. **Dead Config:** Existing settings for tool history are partially unused.

## Goals

1. Preserve recent tool call → result pairs in full fidelity.
2. Aggressively compress older tool history while retaining key facts.
3. Maintain a single source of truth for tool history rendering.
4. Enable a safe migration to native `function_call` items when available.

## Current Constraints

- **Gateway rejects `function_call` input items** (pending deployment of upstream support).
- **Marketplace builds cannot rely on proposed APIs** for tool call semantics.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                  openresponses-chat.ts                       │
│  1. Extract tool call/result pairs                           │
│  2. Feed ToolHistoryManager                                  │
│  3. Render items via strategy                                │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────┐
│                  ToolHistoryManager                          │
│  - addToolCall(...)                                          │
│  - getCompactedHistory()                                     │
│  - renderAsItems(strategy)                                   │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────┐
│            ToolHistoryStrategy (interface)                   │
│  - renderEntry(entry) → ItemParam[]                          │
│  - renderSummary(summary) → ItemParam[]                      │
└──────────────┬──────────────────────┬───────────────────────┘
               │                      │
               ▼                      ▼
      TextEmbedStrategy        NativeStrategy
      (current)                (future)
```

## Truncation Design (Tool History Tiers)

```
TIER 1: System + Original Intent
TIER 2: Historical Summary (compressed)
TIER 3: Recent Context (full tool call/result pairs)
TIER 4: Current Turn
```

### Tool Call Categories

| Category            | Examples                                | Truncation Strategy                         |
| ------------------- | --------------------------------------- | ------------------------------------------- |
| Read operations     | `read_file`, `list_dir`, `grep_search`  | Aggressive: summarize what was read         |
| Write operations    | `create_file`, `apply_patch`            | Summarize what changed                      |
| Executions          | `run_in_terminal`                       | Keep errors; summarize successes            |
| Queries             | `semantic_search`, `list_code_usages`   | Very aggressive: summarize only             |

### Example Truncation

**Before:** full tool call and result text.  
**After:** `"[Earlier: Read /src/foo.ts lines 1-50]"`

## Strategy Pattern

### TextEmbedStrategy (Current)

- Omit tool call parts (avoid mimicry).
- Emit tool results as user text (with optional markers).
- Keeps behavior compatible with current Gateway constraints.

### NativeStrategy (Future)

- Emit `function_call` and `function_call_output` items.
- Preserve structure and reduce overhead.
- Requires Gateway support for `function_call` input items.

## Implementation Phases & Status

### Phase 0 (Current Reality)

- Tool calls embedded or omitted due to Gateway restrictions.
- Tool history truncation implemented with text summaries.
- **Status:** In use today.

### Phase 1: Unified ToolHistoryManager (Strategy Pattern)

- Introduce `ToolHistoryStrategy` interface.
- Render all tool history through `ToolHistoryManager`.
- Remove inline tool handling in translation path.
- **Status:** Planned.

### Phase 2: Native Tool History Migration

- Enable `function_call` input items when Gateway accepts them.
- Provide safe fallback to text embedding on error.
- **Status:** Blocked on Gateway deployment (PR vercel/ai-gateway#1121).

### Phase 3: Simplify Truncation

- Drop HTML comment parsing.
- Truncate by item pairs instead of text compression.
- **Status:** Planned.

## Configuration

Existing configuration remains valid for truncation control:

```jsonc
{
  "vercelAiGateway.toolHistory.recentCallsToKeep": 6,
  "vercelAiGateway.toolHistory.truncationThreshold": 10000
}
```

## Migration Strategy

1. **Feature flag**: `vercelAiGateway.experimental.nativeToolHistory` (default: false).
2. **Try native first**; fallback to text embedding on `Invalid input` error.
3. **Deprecate flag** when Gateway support is confirmed and stable.

## Acceptance Criteria

- Recent tool call pairs are preserved in full detail.
- Older tool history is summarized without losing key facts.
- `ToolHistoryManager` becomes the single source of truth.
- Native tool history can be enabled without breaking older deployments.

## Open Questions

1. When should truncation trigger (token threshold vs. count)?
2. Should LLM-assisted summarization be used for older history?
3. How to best surface truncation to the user?

## References

- RFC 013: Tool Call Truncation for OpenResponses
- RFC 00024: Native Tool History Migration
- RFC 00025: Unified Tool History Architecture
- `packages/openresponses-client/IMPLEMENTATION_CONSTRAINTS.md`
