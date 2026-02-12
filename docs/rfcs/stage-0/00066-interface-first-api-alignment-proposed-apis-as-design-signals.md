---
title: Interface-First API Alignment: Proposed APIs as Design Signals
feature: architecture
exo:
    tool: exo rfc create
    protocol: 1
---

# RFC 00066: Interface-First API Alignment: Proposed APIs as Design Signals

**Status:** Stage 0 (Idea)
**Created:** 2026-02-12
**Related:** RFC 028 (Proposed APIs Strategy)

## Summary

Extract clean interfaces from the extension's current workarounds, using VS Code's proposed API shapes as co-design signals. This produces better abstractions than either the workaround or the proposal alone — and is architecturally decoupled from any decision about when to adopt proposals.

## Insight

Designing interfaces from **both sides simultaneously** — the workaround (which knows real constraints) and the proposed API (which knows the intended shape) — surfaces design questions that neither side reveals alone.

For example: modelling the stateful marker MIME hack as an implementation of `ConversationIdentityProvider` forces us to answer "what happens on first turn?" and "who generates the UUID?" — questions the current code answers implicitly but never documents.

## Interface Candidates

### 1. ConversationIdentityProvider

**Current workaround:** Stateful marker MIME type hack — encode sessionId in a custom DataPart, read it back on next turn.

**Proposed API:** `chatRequest.conversationId` or similar stable identifier.

**Design questions the interface surfaces:**
- What happens on first turn (no prior ID)?
- Who generates the UUID — the provider or the caller?
- Is the ID guaranteed stable across VS Code restarts?

### 2. TokenCountProvider

**Current workaround:** ai-tokenizer estimation (counter.ts), delta estimation, display.ts abstraction.

**Proposed API:** Token counting surface on chat participants or language models.

**Design questions the interface surfaces:**
- Per-message vs. whole-context counting?
- Streaming (partial) vs. complete counts?
- How does delta estimation compose with actual counts?

### 3. ThinkingContentProvider

**Current workaround:** Custom DataPart with thinking MIME type, sniffed by consumers.

**Proposed API:** First-class `LanguageModelThinkingPart` in the response stream.

**Design questions the interface surfaces:**
- Streaming thinking (partial blocks) vs. complete blocks?
- Are thinking blocks always present or opt-in?
- How do thinking blocks interact with token counting?

## Triage Framework

For each proposed API, classify as:

| Category | Criteria | Action |
|----------|----------|--------|
| **Adopt soon** | Proposal is mature, actively developed, likely to stabilize | Build a flagged implementation now |
| **Design toward** | Proposal exists but timeline unclear | Use its shape to inform interface design, don't build implementation yet |
| **Watch** | Early-stage proposal | Note it, don't let it influence current architecture |

## Next Step: Proposal Audit

Use the vscode-proposal-signals infrastructure to:
1. Enumerate all AI-related VS Code proposed APIs
2. For each, document: what it does, how it maps to current extension code, triage classification
3. Update this RFC with the full inventory and triage results

## Non-Goals

- This RFC does NOT decide when to adopt any specific proposal
- This RFC does NOT require switching to VS Code Insiders
- This RFC does NOT change any current behavior

## Relationship to RFC 028

RFC 028 defines the **two-build strategy** (stable vs. Insiders) and the **runtime feature detection** pattern. This RFC adds the **interface-first design** layer on top — using proposals as design signals to improve the architecture regardless of adoption timeline.
