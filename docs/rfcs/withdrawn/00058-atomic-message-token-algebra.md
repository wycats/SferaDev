---
title: Atomic Message Token Algebra
stage: 1
feature: Unknown
exo:
  tool: exo rfc create
  protocol: 1
withdrawal_reason: "References removed atomic message token algebra infrastructure"
---

# RFC 00058: Atomic Message Token Algebra

## Status

- **Stage**: 1 (Proposal)
- **Supersedes**: [RFC 029](../stage-0/029-hybrid-token-estimator.md), [RFC 042](../stage-0/042-transcript-digest-correlation.md), [RFC 00052](../stage-0/00052-content-hash-delta-caching-for-per-message-token-attribution.md)
- **Decouples**: [RFC 00047](../stage-0/00047-rolling-correction-for-providetokencount.md) (Rolling correction becomes a secondary safety rather than primary mechanism)

## 1. Problem Statement

Token estimation accuracy for long conversations (80k+ tokens) in VS Code is currently hampered by "State Amnesia." Previous models relied on **Prefix-Chain Identity**, assuming that turn $N$ and turn $N+1$ must share a perfect common prefix to reuse token counts.

**The Failure Points:**

1. **Index 0 Drift**: VS Code dynamically injects context (e.g., `<agents>` blocks, workspace instructions) into the System Prompt. Any single-character change at the start of the conversation invalidates the entire 100k token cache anchor.
2. **Brittle Learning**: Previous delta-caching logic was "all-or-nothing." If a turn added more than one message (e.g., Tool Call + Tool Result), the system refused to cache either, causing "ground truth gaps."
3. **The "Bad Math" Trap**: When amnesia strikes, the system falls back to conservative character-based estimation, causing the status bar to "jump" by 20-40k tokens instantly when the API returns the actual count.

## 2. Proposed Solution: Atomic Message Algebra

We move from a **Linear History** model to an **Atomic Set** model. Conversations are treated as collections of independent, verifiable message identities.

### 2.1 Atomic Identity (Normalized Hashing)

Every message is hashed into a stable `Digest(M)` that is invariant across turns. Normalization aggressively strips:

- Unstable IDE metadata (e.g., ephemeral `callId`, `name` fields).
- Semantic-null drift (whitespace squashing, JSON canonicalization for tool results).
- URI local-path drift (normalizing file paths in content).

### 2.2 The Proportional Learning Rule

When an API returns an actual token count $A$, we deduce the cost of new messages by distributing the actual delta relative to their local estimates (e.g., TikToken).

$$Tokens(M_i) = (Actual_{Total} - \sum Tokens(M_{known})) \times \frac{Estimate(M_i)}{\sum Estimate(M_{unknown})}$$

This allows the system to learn from **any** turn, proportionalizing the error across all new messages rather than abandoning the learning event.

### 2.3 Resilient Anchor Salvaging

The system matches conversations via **set intersection**, not positional prefix matching. A known state is considered a match if a sufficient subset of its message hashes appear in the current conversation's message set, regardless of position.

This explicitly tolerates several **drift patterns**, each with distinct semantics:

| Pattern                 | Detection                                                                         | Semantic Action                                                                            |
| ----------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **System Prompt drift** | Hash at index 0 differs                                                           | Treat as "new" message; no cache invalidation                                              |
| **User edit**           | Known hash disappears, new hash at same logical position                          | Invalidate cached tokens for that message                                                  |
| **Summarization**       | `<conversation-summary>` tag appears + older hashes missing + newer hashes intact | Associate summary with replaced messages; sum their tokens as "compacted tokens" (RFC 047) |
| **Reload/session**      | Metadata-only differences (`$mid`, `cache_control` data parts)                    | Normalization strips these; no semantic impact                                             |

**Note**: Context window pressure (backend dropping oldest messages) is a theoretical concern but has not been observed in practice with 128k context models. If observed, log a drift event and anchor on remaining messages.

The goal is not just to _tolerate_ these patterns, but to _detect_ them and apply pattern-specific logic. For summarization specifically, the presence of the summary tag combined with the "missing older / intact newer" signature allows us to precisely identify which messages were compacted and display this in the UI.

When selecting among multiple candidate matches, prefer the candidate with the **fewest misses** (known hashes not found in the current set). If tied, prefer the candidate with the **most matches** (larger anchor = more ground truth).

## 3. Design Goals

1. **Zero-Jump Stability**: Prevent the "Token Jump" on turn completion by maintaining high-confidence anchors despite IDE-injected noise.
2. **Incremental Context Wealth**: Every turn becomes a learning turn. The message cache builds its own "Ground Truth" dictionary effortlessly.
3. **Resilience to Truncation**: If history is truncated by the IDE, atomic message identity remains valid even if the prefix chain is broken.

## 4. Implementation Details

- **Message Cache**: A persistent 2000-entry LRU store keyed by `(ModelFamily, NormalizedDigest)`.
- **Drift Forensics**: Log identity drift events to the output channel to identify whenever normalization or resilient matching salvaged a cache hit.
- **Triangulation**: Over time, a message appearing in different conversations allows us to narrow down its exact token cost by isolating it against different sets of "knowns."