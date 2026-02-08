# Token Estimation Reality: The "Bad Math" Trap (Deprecated)

> **Status**: Deprecated.
> **Reason**: Superseded by **RFC 00057: Unified Atomic Token Algebra**. The "Linear Prefix" and "Anchor" assumptions in this document are incorrect.

**Last Updated:** 2026-02-07
**Context:** VS Code AI Gateway Token Tracking

## The "Bad Math" Fallacy

When investigating discrepancies in token counts (Status Bar vs. Reality), agents almost invariably fall into the "Bad Math" trap:

> "The status bar shows 30k, but the API returned 50k. Our token estimator must be missing something (overhead, special tokens, JSON schema weights). I should tune the constants."

**This is a critical error in reasoning.**

While token estimators are imprecise, they are **mathematically bounded**.

- A sloppy estimator might be off by 10-15%.
- A completely broken estimator (char count / 4) might be off by 20-30%.
- **No estimator is off by 40-50% on standard English text/code.**

## The Real Culprit: State Amnesia

If you observe:

1.  **Massive Jumps**: Token count jumps by 10k, 20k, or 50k instantly after an API response.
2.  **Persistent Undercounting**: The status bar consistently shows ~60% of the actual usage.

**The cause is State Persistence Failure (Amnesia).**

### How it works

The `ConversationStateTracker` is supposed to remember the "Ground Truth" token count returned by the API for previous turns.

- **Scenario A (Working)**:
  - Turn 1: 10k real tokens. API says "10,000". We store `State(10,000)`.
  - Turn 2: User Types "Hello".
  - Estimate: `State(10,000) + Estimate("Hello")` = 10,005. **Accuracy: 99.9%**.
- **Scenario B (Amnesia/Collision)**:
  - Turn 1: 10k real tokens. API says "10,000". We store `State(10,000)` but overwrite it or lose the key.
  - Turn 2: User Types "Hello".
  - System looks for `State`. Finds nothing.
  - Fallback: `Estimate(Turn 1 + Turn 2)`.
  - Estimator says Turn 1 is 6k (because it's conservative).
  - Estimate: 6,005. **Accuracy: 60%**.
  - **Result**: User sees "6k". API returns "10k". **Jump**: +4k.

## Case Study: The Cache Collision Bug (Feb 2026)

We spent days debugging "estimation errors" when the actual bug was in `conversation-state.ts`.
The tracker was using `modelFamily` as the cache key.

- Conversation A (Tab 1): `claude-3-opus` -> Sets `knownState = 10k`.
- Conversation B (Tab 2): `claude-3-opus` -> Overwrites `knownState = 500`.
- Switch back to Tab 1: System has no memory of 10k. Estimates from scratch. Result: 6k.
- API returns: 10k.
- **Jump**: 4k.

## The Solution: Atomic Message Algebra (Implemented Feb 2026)

The final fix for "State Amnesia" was moving from a **Prefix-Chain** model to an **Atomic Set** model.

### 1. Resilient Match

We identified that the **System Prompt (Index 0)** frequently drifts due to IDE-injected context (e.g., `<agents>` tags). This "snapped the anchor" of our prefix cache. We now allow Index 0 to drift if the remainder of the history (User/Assistant exchanges) is stable.

### 2. Proportional Distribution

When we receive a new "Ground Truth" count for $N$ new messages, we no longer skip caching or "average" the cost. We use a local estimator (TikToken) to get relative weights and then distribute the actual tokens proportionally:
$$Tokens(M_i) = \Delta_{actual} \times \frac{Tiktoken(M_i)}{\sum Tiktoken(M_{new})}$$

### 3. Stability through Triangulation

Because every message builds its own individual cache entry across turns, the system "self-heals" even if the conversation structure changes (e.g., history truncation or summarization).

---

## Checklist for Future Agents

Before touching `src/tokens/counter.ts`:

1.  **Check the Magnitude**: Is the error >20%? If yes, it is **NOT** math. It is memory.
2.  **Verify Resilient Match**: Look at the logs for `[ConversationState] Resilient Match triggered`. If it's not triggering, why?
3.  **Audit the Digest**: Check `computeNormalizedDigest` in `src/utils/digest.ts`. If the IDE added a new field (like `contextSource`), it must be stripped or the atomic identity is lost.

## Codebase "Traps"

The code is structured in a way that encourages this fallacy:

1.  `TokenCounter` is large, complex, and full of "tunable" constants. It looks like the place to fix math.
2.  `ConversationStateTracker` fails silently and elegantly falls back to estimation.
3.  The UI just shows a number, masking the source (Cached vs Estimated).
