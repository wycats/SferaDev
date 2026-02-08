---
title: Unified Atomic Token Algebra
stage: 1
feature: Unknown
exo:
    tool: exo rfc create
    protocol: 1
---

# RFC 00059: Unified Atomic Token Algebra

## 1. Summary

This RFC defines a "First Principles" architecture for token estimation and conversation state tracking in the VS Code AI Gateway. It rejects the fragile "Linear Prefix" model in favor of a robust **Atomic Message Token Algebra** based on Set Theory.

The system treats a conversation as a **Set of Atomic Messages**, using an **Inverted Index** for lookup and **Proportional Distribution** for learning ground-truth token counts.

## 2. Motivation

### The Problem: The "Linearity Fallacy"
Previous iterations assumed conversations were linear append-only logs anchored by a stable System Prompt (Index 0). This assumption is false in VS Code Copilot:
1.  **System Prompt Drift**: The system prompt changes implicitly based on context (open files, selection), often changing Index 0 without the user's knowledge.
2.  **State Amnesia**: A change at Index 0 breaks the "string of pearls," causing the system to treat the entire conversation as new, leading to massive token estimation drifts.
3.  **Heuristic Failure**: Attempts to patch this with "Suffix Matching" or "Fuzzy Logic" created a complex, unmaintainable web of heuristics.

### The Solution: Atomic Algebra
We fundamentally redefine the unit of tracking from the "Conversation Sequence" to the "Atomic Message."
-   If a message exists, its token count is immutable.
-   A conversation's identity is defined by the **Intersection** of its constituent messages, not their order.
-   Drift is not an error; it is simply a lower Intersection Count.

## 3. Core Philosophy

### 3.1. Identity by Intersection
A conversation $C$ is a set of message hashes $M_C = \{h_1, h_2, ..., h_n\}$.
An incoming request $R$ has message hashes $M_R = \{r_1, r_2, ..., r_m\}$.

The **Identity** of the conversation is the candidate $C_i$ that maximizes the intersection magnitude:
$$
Identity(R) = \max_{C_i \in States} | M_{C_i} \cap M_R |
$$

This requires no anchors. If the System Prompt ($r_0$) changes, the intersection count simply drops by 1. The system still correctly identifies the history context using the remaining $N-1$ messages.

### 3.2. Irrelevance of Structure (The "Bag of Messages" Principle)
Once the Identity and its associated messages are found, we **DO NOT** verify the linear order (prefix structure) of the messages.

Because of the **Principle of Atomic Summation**:
$$
TotalTokens(Conversation) = \sum_{m \in Messages} ActualTokens(m)
$$

The calculation is typically:
$$
Total = \sum KnownAtomicActuals + \sum EstimatedNewMessages
$$

Since addition is commutative ($A+B = B+A$), the order of messages does not affect the token count. "Prefix Validation" or "Resilient Matching" are artifacts of the legacy model where we only cached the *sum of a sequence*. In the Atomic model, we cache the *parts*, so the structure of the *whole* is irrelevant for token estimation.

### 3.3. Proportional Learning (The Feedback Loop)
We assume the API is the source of truth. When we receive a `usage` report, we calculate the "Delta" (Tokens spent on *new* messages).

First, define the **Residual Delta**:
$$
Delta_{residual} = TotalActual_{API} - \sum_{m \in KnownMessages} ActualTokens(m)
$$

We then distribute this residual to the *unknown* messages using a **Proportional Distribution** model based on their local `tiktoken` weights:

1.  **Estimate**: Calculate local `tiktoken` estimates for all unknown messages.
2.  **Ratio**: Determine the contribution ratio of each message relative to the group.
3.  **Distribute**:
    $$
    Actual_{msg} = Delta_{residual} \times \frac{TikToken_{msg}}{\sum_{u \in Unknowns} TikToken_{u}}
    $$

This allows the system to "learn" precise ground-truth values for new messages and store them in a **Global Message Cache**.

## 4. Architecture

### 4.1. The Inverted Index (Search Engine)
To perform Intersection operations in $O(1)$ time, we maintain an **Inverted Index**:

```typescript
// Maps an atomic message hash to the set of conversations containing it.
Map<MessageHash, Set<ConversationID>>
```

**Lookup Algorithm**:
1.  Compute hashes for all messages in the request.
2.  Query the Index for each hash.
3.  Aggregating the hits:
    *   `Count[ConvID]++` for each hit.
4.  Select `ConvID` with the highest count.
    *   *Tie-breaker*: Most Recently Used (MRU).

### 4.2. Strict Lifecycle & Hygiene
The Inverted Index is a **Primary Consistency Mechanism**, not a loose cache.
-   **Atomic Updates**: Adding a conversation state adds its keys to the Index immediately.
-   **Coupled Eviction**: When the LRU evicts a conversation from `knownStates`, it **MUST** synchronously remove the corresponding entries from the Inverted Index.
-   **Result**: No "Ghost Keys." Memory usage is bounded strictly by the configured max entries (e.g., 100 conversations).

### 4.4. Canonical Normalization (Forward Projection)
A critical requirement is that the hash of a message we *receive* from VS Code history matches the hash of the message we *stored* after generating it.

VS Code (via our Stream Adapter) modifies the raw LLM output before displaying it (e.g., merging separate `citation` events into the text stream as `[title](url)`).

**The Forward Projection Principle**:
We do not attempt to "strip" or reverse-engineer these modifications when hashing VS Code history. Instead, when we learn the "Ground Truth" tokens from an API response, we must:
1.  **Project** the Raw API Response into the exact shape of a VS Code Message (applying the same transformations the Stream Adapter does).
2.  **Hash** this Projected Message.
3.  **Store** `Hash(projected) -> ActualTokens(raw)`.

This ensures that the key in our Global Message Cache aligns with what VS Code will send back to us in future requests, eliminating fragile regex stripping or "fuzzy" content matching.

**Normalization Rules**:
1.  **Project Content**: Apply all stream transformations (merge citations, format tool calls).
2.  **Ignore Identifiers**: Exclude fields that VS Code does not reliability preserve (specifically `callId` and `name`). The hash is strictly of the *Semantic Content* (Role + Projected Text/Data).

## 5. Implementation Plan

### Phase 1: Storage Refactor (Done)
-   Refactor `ConversationStateTracker` to include `messageIndex: Map<string, Set<string>>`.
-   Implement rigorous `addToIndex` / `removeFromIndex`.

### Phase 2: Identification Logic (Done)
-   Implement `identifyConversation(hashes)` using the frequency counting algorithm.
-   Replace linear `accessOrder` iteration in `lookup`.

### Phase 3: Proportional Math (Done)
-   Update `hybrid-estimator.ts` to implement the Proportional Distribution math for deltas.

### Phase 4: Forward Projection (New)
-   Create `projectToVsCodeMessage(openResponseItems)` utility.
-   Update `hybrid-estimator.ts` to hash the *projected* message when caching ground truth.
-   Remove `stripAdditions` logic from `digest.ts`.

### Phase 5: Cleanup (Pending)
-   Remove legacy "Suffix Match" code.
-   Remove legacy "Linear Prefix" documentation.
-   Update `docs/manual/` to reflect the new architecture.

## 6. Glossary

-   **Atomic Message**: A single message in the chat (Role + Content), uniquely identified by its Hash.
-   **Inverted Index**: The core data structure mapping Messages to Conversations.
-   **Intersection Count**: The metric used to identify conversation candidate.
-   **Proportional Distribution**: The algorithm for assigning `Delta` tokens to specific messages.
