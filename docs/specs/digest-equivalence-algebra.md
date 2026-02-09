# Atomic Message Token Algebra

> **Purpose**: A resilient model for token estimation based on independent message identity rather than prefix continuity.
> **Philosophy**: Every message has an intrinsic token cost for a given model. Conversations are sets of messages, not immutable chains.
> **Replaces**: The previous "Prefix Equivalence" model which was brittle to IDE-injected system prompt drift.

## 1. The Atomic Identity Principle

A message's token count is a function of its **normalized content** and the **target model family**.

$$Tokens(M, Model) = f(Digest(M), Model)$$

### Message Digest

The digest $D(M)$ must be invariant across turns. It excludes unstable IDE-injected fields (like ephemeral IDs or UI-specific metadata) and focuses on the semantic content:

- **Role**: (User, Assistant, System)
- **Content**: Normalized text (stripped of whitespace drift) and canonicalized tool/data payloads.

## 2. The Conversation Equation

The total input tokens $I_{total}$ reported by an API is the sum of three components:

$$I_{total} = \sum_{i=0}^{n} Tokens(M_i) + O_{system} + O_{tools}$$

Where:

- $\sum Tokens(M_i)$: Sum of individual message costs.
- $O_{system}$: Overhead for the system prompt and instructions.
- $O_{tools}$: Overhead for tool definitions/schemas.

### The Complexity of System Drift

In VS Code, $M_0$ (System Prompt) is unstable. It drifts turn-by-turn as Copilot injects dynamic context. Because $M_0$ is unstable, the "Prefix Anchor" is unreliable. We treat $M_0$ as a special variable part of the "Conversation Overhead" rather than a stable atomic message when looking up prefix hits.

## 3. Structural Normalization

### The Text Fragmentation Problem

VS Code's internal representation of chat messages is unstable with respect to text fragmentation. A single message `Hello world` may be represented as:

1.  `[{ "text": "Hello world" }]` (Turn 1)
2.  `[{ "text": "Hello" }, { "text": " world" }]` (Turn 2, or after streaming)

This fragmentation is often an artifact of streaming responses or upstream request parsing (identifying references or commands) and does not represent a semantic difference. However, strictly hashing the `content` array structure causes the digest to change ($D(M_1) \neq D(M_2)$), breaking message identity.

**Solution: Semantic Text Merging**
The digest algorithm MUST normalize the content structure by merging adjacent text parts into a single text block/string before hashing.

$$ Normalize([T_1, T_2, ...]) \rightarrow [T_{merged}] $$

This ensures that $D(["A", "B"]) = D(["AB"])$, recovering stability for user messages.

## 4. The Proportional Learning Rule

When we receive an actual token count $A$ from an API, we can "learn" the counts for unknown messages by distributing the delta according to their relative weights.

### The Algorithm

Given a conversation with $n$ messages where some have known "Ground Truth" counts and others are new/unknown:

1.  **Isolate the Actual Delta ($\Delta_{act}$)**:
    Subtract all known stable message counts from the reported total.
    $$\Delta_{act} = A - \sum_{M \in Known} Tokens(M)$$

2.  **Estimate Weights ($W_i$)**:
    For all unknown messages $U$, compute a local estimate (e.g., TikToken).
    $$W_i = Estimate(M_i)$$

3.  **Apportion tokens via Ratio**:
    Attribute tokens to each unknown message $M_i$ proportional to its weight.
    $$Tokens(M_i) = \Delta_{act} \times \frac{W_i}{\sum_{j \in U} W_j}$$

### Why this is superior to Averaging:

- **Weighted Accuracy**: If an image part is 1000 tokens and a text part is 10 tokens, averaging would assign 505 to each. Proportional scaling preserves the magnitude of the difference.
- **Provider Alignment**: It automatically scales local estimates to match the provider's specific counting logic (e.g., how they count tool result overhead).

## 5. Multi-Turn Triangulation

Atomic counts are refined over time as messages appear in different contexts.

- **Turn 1**: We see $[M_1, M_2]$. We learn their approximate values via weighted distribution.
- **Turn 2**: We see $[M_1, M_2, M_3]$. Since we "know" $M_1$ and $M_2$ from Turn 1, we can isolate $M_3$ with much higher precision.
- **Conflict Resolution**: If the same $Digest(M)$ yields different scaled counts in different turns, we store the **most recent** value, provided it came from a "Pure" turn (one with fewer unknown messages).

## 6. Resilience to "State Amnesia"

### 1. Handling System Prompt Drift (The "Relaxed Match" Strategy)

When the System Prompt ($M_0$) varies between turns (a common VS Code behavior):

1.  **Strict Lookup Fails**: The conversation state hash changes, preventing a "Delta" estimate.
2.  **Fallback to Fresh Estimate**: We perform a full local estimate (TikToken) on the _new_ content. This ensures no under-counting occurs; if the System Prompt grew by 500 tokens, we count them.
3.  **Identity Recovery**: We use "Relaxed Prefix Matching" (ignoring Index 0) to recover the persistent `conversationId`.
4.  **Result**: The user sees continuity (same ID) and accurate estimation (fresh calculation), avoiding the "reset to zero" UX.

### 2. History Truncation: If the IDE removes $M_1$ and $M_2$ (context window management), we don't lose the counts for $M_3 \dots M_n$.

### 3. Summarization: When a `<conversation-summary>` is injected, it is treated as a single new atomic message. We learn its cost on the very first turn it appears, and it remains stable thereafter.

## 7. Implementation Constraints

### Cache Invalidation

- **LRU Pruning**: The message cache is managed via Least Recently Used.
- **Conversation TTL**: To prevent memory leaks, we prune mappings for messages that haven't appeared in an active conversation for $>24$ hours.

### Normalization Requirements

To ensure $Digest(M)$ stability:

1.  **Canonical JSON**: Tool results must have keys sorted alphabetically.
2.  **Whitespace Squeezing**: Multiple spaces/newlines are collapsed to ensure minor formatting changes don't break identity.
3.  **URI Neutrality**: Local file paths in content are normalized to remove user-specific prefixes.

4.  Are A1-A4 actually true? (empirical verification needed)
5.  What's the most efficient digest scheme? (Merkle vs flat hash)
6.  How do we handle summarization? (prefix won't match — that's intentional)
