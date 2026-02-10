---
title: Content-Hash Delta Caching for Per-Message Token Attribution
stage: 0
feature: Unknown
exo:
  tool: exo rfc create
  protocol: 1
---

# RFC 00052: Content-Hash Delta Caching for Per-Message Token Attribution

## Status

Stage 0 — Idea

## Pivot: From Response-ID to Content-Hash

### Original Approach (Invalidated)

This RFC originally proposed using `previous_response_id` from the OpenResponses API to compute token deltas between turns. The theory was:

```
delta_tokens = current.input_tokens - cached[previous_response_id].input_tokens
```

### Why It Failed

**Empirical testing proved this approach won't work.** The OpenResponses gateway only echoes `previous_response_id` from the request — it doesn't track conversation continuity server-side. Since Copilot controls the request and doesn't set `previous_response_id`, it's always `null`.

### New Approach: Content-Based Identity

We can achieve the same goal using **content-based identity** via message hashes. The infrastructure already exists:

- `ConversationStateTracker.lookup()` returns prefix match information
- `TokenCache.cacheActual()` stores per-message token counts
- Hash unification ensures consistent message identity

The key insight: we don't need the server to track conversation continuity — we can detect it ourselves by comparing message hash arrays.

## Related RFCs

- **RFC 047** (Rolling Correction): Complementary mechanism; this RFC reduces reliance on rolling correction by providing ground-truth per-message counts
- **RFC 049** (Assumption Validation Regime): Addresses assumption M4 ("provideTokenCount lacks conversation identity")

## Problem Statement

### The Core Challenge

VS Code's `provideTokenCount(model, message, token)` API receives a single message with no conversation context. We need accurate per-message token counts, but:

1. **Tiktoken underestimates** by 10-40% compared to actual API tokenization
2. **Rolling correction** (RFC 047) compensates but has limitations:
   - Cross-contamination between conversations (family-key dual-write)
   - Requires estimate-vs-actual pairs to calibrate
   - Adjusts future estimates, doesn't provide ground truth

### The Opportunity

When we receive an API response with `usage.input_tokens`, we can compare the current message array against previously recorded states:

```typescript
const lookup = conversationStateTracker.lookup(
  messages,
  modelFamily,
  conversationId,
);
if (lookup.type === "prefix" && lookup.knownTokens !== undefined) {
  const delta = actualInputTokens - lookup.knownTokens;
  const perMessageTokens = delta / lookup.newMessageCount;
  // Cache each new message with its attributed tokens
}
```

This delta represents the **exact token count** of the new message(s) added since the previous turn.

## Proposed Solution

### Mechanism

1. **On every API response:** Call `ConversationStateTracker.lookup(messages, modelFamily, conversationId)`
2. **If prefix match found:**
   - Compute `delta = actualInputTokens - lookup.knownTokens`
   - Determine new messages from `lookup.newMessageIndices`
3. **If exactly 1 new message:** Cache `hash(message) → delta` for that message
4. **If N > 1 new messages:** Split delta evenly: `delta / N` per message (acceptable approximation for VS Code's total-based summarization decision)
5. **After caching:** Call `recordActual()` to update conversation state for next turn
6. **On future `provideTokenCount(message)`:** Return cached actual if available

### Why Split Evenly Is Acceptable

VS Code's summarization decision uses the **total token count** across all messages, not per-message accuracy. From RFC 047:

> Summarization uses TOTALS, not per-message counts. There's ~15% tolerance built in.

If we add 3 messages totaling 3000 tokens:

- Split evenly: 1000 + 1000 + 1000 = 3000 ✓
- Actual distribution: 500 + 2000 + 500 = 3000 ✓

The total is correct either way. Per-message distribution affects only display, not the summarization decision.

### Data Flow

```
OpenResponses API
  └─ response.completed { usage.input_tokens }
       |
       v
openresponses-chat.ts
  └─ onUsage(inputTokens, messages)
       |
       v
provider.recordUsage()
  └─ HybridTokenEstimator.recordActual()
       |
       ├─ lookup = ConversationStateTracker.lookup(messages, modelFamily, conversationId)
       ├─ if (lookup.type === "prefix"):
       │    delta = inputTokens - lookup.knownTokens
       │    perMessageTokens = delta / lookup.newMessageCount
       │    for each newMessageIndex:
       │      TokenCache.cacheActual(messages[index], modelFamily, perMessageTokens)
       └─ ConversationStateTracker.recordActual(messages, modelFamily, conversationId, inputTokens)
           |
           v
    Future provideTokenCount(message) returns cached actual
```

## Implementation Plan

### Phase 1: Add Lookup-Before-Record Pattern

**Files:** tokens/hybrid-estimator.ts

1. In `recordActual()`, call `ConversationStateTracker.lookup()` **before** updating state
2. Extract `knownTokens` and `newMessageIndices` from lookup result
3. Compute delta if prefix match found
4. Pass delta and new message info to caching logic

### Phase 2: Integrate TokenCache Population

**Files:** tokens/hybrid-estimator.ts, tokens/cache.ts

1. If delta > 0 and newMessageCount > 0:
   - Compute `perMessageTokens = Math.round(delta / newMessageCount)`
   - For each new message index, call `tokenCache.cacheActual(message, modelFamily, perMessageTokens)`
2. Ensure hash consistency between lookup and cache (already unified)

### Phase 3: Handle Edge Cases

**Files:** tokens/hybrid-estimator.ts

1. **First turn (no previous state):** Skip delta caching; just record state
2. **Summarization (message count drops):** Lookup returns "none"; skip delta caching
3. **Negative delta (shouldn't happen):** Log warning; skip caching
4. **Zero new messages:** Skip per-message caching

### Phase 4: Persistence

**Files:** tokens/cache.ts, tokens/hybrid-estimator.ts

**Goal:** Cached per-message token counts survive extension restarts.

**Mechanism:**

1. **Constructor change:** Accept optional `vscode.Memento` parameter
2. **On activation:** Load cache from `globalState`, filtering stale entries (>24h)
3. **On `cacheActual()`:** Schedule debounced write to `globalState` (1s debounce)
4. **LRU eviction:** Maintain access order; evict oldest when exceeding 2000 entries
5. **Storage format:**
   ```typescript
   interface PersistedTokenCache {
     version: 1;
     savedAt: number; // When cache was last persisted
     entries: Array<{
       key: string;
       entry: CachedTokenCount; // Includes per-entry timestamp
     }>;
   }
   ```

**TTL filtering:** Each `CachedTokenCount.timestamp` is checked on load; entries older than 24h are discarded.

**Integration:**

- `HybridTokenEstimator` passes `context.globalState` to `TokenCache` constructor
- Pattern mirrors `ConversationStateTracker` persistence

## Assumptions

| ID  | Assumption                                                       | Validation                                                            |
| --- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| A1  | Message hashes are stable between turns                          | Verified by hash-unification work; same normalization used throughout |
| A2  | Prefix matching correctly identifies conversation continuity     | ConversationStateTracker tests verify this behavior                   |
| A3  | `input_tokens` is monotonically increasing within a conversation | Verify no resets or recounts in production                            |
| A4  | TokenCache lookup uses same hash as ConversationStateTracker     | Ensured by unified `computeNormalizedDigest()`                        |
| A5  | globalState survives extension restarts                          | VS Code Memento API guarantee                                         |
| A6  | 2000 entries × ~100 bytes fits in globalState                    | Well under VS Code's limits                                           |

## Edge Cases

| Case                                            | Behavior                                                 |
| ----------------------------------------------- | -------------------------------------------------------- |
| First turn (no previous state)                  | Record state only; no delta to compute                   |
| Lookup returns "none" (no match)                | Skip delta caching; fall back to rolling correction      |
| Lookup returns "exact" (no new messages)        | Skip per-message caching; state already known            |
| Negative delta (shouldn't happen)               | Log warning; skip caching                                |
| Zero new messages (response without user input) | Skip per-message caching                                 |
| Summarization (message count drops)             | Lookup returns "none"; handled gracefully                |
| Multiple new messages                           | Split delta evenly; acceptable for total-based decisions |

## Interaction with Rolling Correction (RFC 047)

Content-hash delta caching **complements** rolling correction:

| Scenario                               | Delta Caching             | Rolling Correction                   |
| -------------------------------------- | ------------------------- | ------------------------------------ |
| Cache hit (message seen before)        | Returns ground truth      | Not applied                          |
| Cache miss (new message, prefix match) | Computes and caches delta | Not applied                          |
| Cache miss (no prefix match)           | Not available             | Applied to first message of sequence |
| First turn                             | Not available             | Applied after first API response     |

**Net effect:** Rolling correction becomes a fallback for cold start and cache misses. Its cross-contamination issue (Phase 4a family-key dual-write) matters less because cached messages bypass correction entirely.

## Success Metrics

1. **Cache hit rate:** % of `provideTokenCount` calls returning cached actuals
2. **Estimation error:** Compare tiktoken estimate vs cached actual (should show improvement)
3. **Summarization accuracy:** Fewer premature or delayed summarizations

## Open Questions

1. Should we track cache hit/miss rates in telemetry?
2. How do we handle the transition period where some conversations have cached data and others don't?
3. ~~Should we pre-populate cache from conversation state on extension activation?~~ **Resolved:** Phase 4 adds persistence; cache is restored from globalState on activation.
4. Should TokenCache and ConversationStateTracker share a persistence abstraction? (See RFC 034)

## References

- `ConversationStateTracker.lookup()` — Returns prefix match information
- `ConversationLookupResult` interface — Type definition
- `TokenCache.cacheActual()` — Per-message token caching
- RFC 047: Rolling Correction mechanism
- RFC 049: Assumption Validation Regime (M4)
