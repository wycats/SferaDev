---
title: Zombie Identity System GC
stage: 0
feature: Unknown
exo:
  tool: exo rfc create
  protocol: 1
withdrawal_reason: "Describes GC of zombie identity systems — work is complete, systems removed"
---

# RFC 00054: Zombie Identity System GC

## Stage: 0 (Idea)

## Dependencies

> ⚠️ **BLOCKED**: Phase 3 of this RFC depends on RFC 00051 (Model Family String Mapping).
>
> Phases 1-2 can proceed independently. Phase 3 requires RFC 00051's family parsing fix to land first.

## Problem Statement

The codebase contains three incompatible conversation identity/hashing systems from different eras of development:

1. **RFC 009 era**: `learnedTokenTotal` + 1.5x multiplier + `hashConversation()` (first 2 + last 2 messages)
2. **Pre-RFC era**: `conversationId` in provider/estimator (modelId + first user message hash)
3. **Current era**: Normalized digest system (RFC 052) + `getConversationIdentity()` (RFC 033)

The legacy systems are "zombie code" - they still execute but have been superseded by newer mechanisms. They cause:

- **Summarization ping-pong**: The lossy `hashConversation()` doesn't detect summarization when only middle messages change, keeping the 1.5x multiplier active
- **Cross-conversation contamination**: `conversationId` collisions and model-family fallback
- **Maintenance burden**: Three systems to understand and maintain
- **Dead code**: `actualTokens` field is logged but never used

## Zombie Inventory

### Zombie 1: `learnedTokenTotal` + 1.5x Multiplier

| Attribute     | Value                                              |
| ------------- | -------------------------------------------------- |
| Files         | `provider.ts`                                      |
| State         | `{ conversationHash, actualTokens }`               |
| Introduced    | RFC 009 (Reactive Error Learning)                  |
| Superseded by | Rolling correction (RFC 047), TokenCache (RFC 052) |
| Tests         | None                                               |

**Code locations:**

- Declaration: `learnedTokenTotal` field in `GatewayLanguageModelProvider`
- Set: Error parsing path ("too long" detection)
- Read: `provideTokenCount()` applies 1.5x if hash matches
- Clear: On successful request completion

**Why remove:**

- `actualTokens` is dead code (logged only)
- Lossy hash causes ping-pong
- No tests = no safety net, but also no breakage on removal

### Zombie 2: `hashConversation()` + `simpleHash()`

| Attribute     | Value                                                        |
| ------------- | ------------------------------------------------------------ |
| Files         | `provider.ts`                                                |
| Algorithm     | First 2 + last 2 messages, truncated hash via `simpleHash()` |
| Introduced    | RFC 009 era                                                  |
| Superseded by | `computeNormalizedDigest()` (RFC 052)                        |
| Tests         | None direct                                                  |

**Why remove:**

- Only used by `learnedTokenTotal` path
- Lossy: stable across summarization if only middle messages change
- Incompatible with normalized digest system

**Note:** `hashChatMessage()` does not exist; the code uses `simpleHash()` directly on message content.

### Zombie 3: `conversationId` / `conversationIdentity` in Provider

| Attribute     | Value                                                                        |
| ------------- | ---------------------------------------------------------------------------- |
| Files         | `provider.ts`, `hybrid-estimator.ts`                                         |
| Algorithm     | `modelId:hash(firstUserMessage)` - computed in provider, passed to estimator |
| Introduced    | Unknown (pre-RFC)                                                            |
| Superseded by | Digest-based message matching (RFC 052)                                      |
| Tests         | Yes, in `hybrid-estimator.test.ts`                                           |

**Why remove:**

- Weak identity: collides across conversations with same first message
- Model-family fallback defeats its purpose (reintroduces cross-conversation contamination)
- Incompatible with digest-based system already in TokenCache

**How `family` flows through this zombie:**

```
parseModelIdentity() → model.family
                            │
                            ▼
         ┌──────────────────────────────────────┐
         │       hybrid-estimator.ts            │
         │  ┌─────────────────────────────────┐ │
         │  │ knownStates.get(familyKey)      │ │
         │  │ knownStates.get(conversationKey)│ │
         │  │ Rolling correction uses BOTH    │ │
         │  └─────────────────────────────────┘ │
         └──────────────────────────────────────┘
                            │
                            ▼
         ┌──────────────────────────────────────┐
         │         token/counter.ts             │
         │  ┌─────────────────────────────────┐ │
         │  │ Cache key: {family}:{textHash}  │ │
         │  │ resolveEncodingName(family)     │ │
         │  └─────────────────────────────────┘ │
         └──────────────────────────────────────┘
```

**RFC 00051 dependency:**

- If `family` derivation is broken (e.g., `claude-sonnet-4.5` → `claude-sonnet`), then:
  - Rolling correction state leaks between models
  - Cache keys collide between distinct models
- Phase 3 increases reliance on family-only keying, which amplifies this risk
- **RFC 00051 must fix family parsing before Phase 3 proceeds**

## Non-Zombie Systems (Keep)

| System                      | Location              | Purpose                              | Uses `family`?              |
| --------------------------- | --------------------- | ------------------------------------ | --------------------------- |
| `computeNormalizedDigest()` | `digest.ts`           | Per-message identity for cache/delta | No                          |
| `getConversationIdentity()` | `status-bar.ts`       | UI agent tracking                    | No                          |
| `computeAgentTypeHash()`    | `hash-utils.ts`       | Parent-child linking                 | No                          |
| TokenCache                  | `cache.ts`            | Per-message token caching            | No (uses digest)            |
| Rolling correction          | `hybrid-estimator.ts` | Systematic estimate adjustment       | **Yes** (keyed by family)   |
| `resolveEncodingName()`     | `counter.ts`          | Tokenizer selection                  | **Yes** (fragile heuristic) |

**Note:** Rolling correction and tokenizer selection both depend on `family`. RFC 00051 identifies that `family` derivation is fragile. These systems benefit from RFC 00051's fix even though they aren't zombies.

## Proposed Solution

### Phase 1: Remove Dead Code

**Scope:** Surgical removal of code that's logged but never used

- Remove `actualTokens` from `learnedTokenTotal` (if we keep the structure temporarily)
- Audit `simpleHash()` usage - may be used by zombie paths only

**Risk:** None - dead code by definition

**Tests:** No new tests needed

### Phase 2: Remove 1.5x Multiplier System

**Scope:** Remove the entire RFC 009 error learning path

**Depends on:** Phase 1 (or can be combined)

**Does NOT depend on:** RFC 00051 (this path uses its own lossy hash, not `family`)

Remove:

- `learnedTokenTotal` field and type
- `hashConversation()` function
- `simpleHash()` if only used by zombie paths (audit first)
- Error parsing that sets `learnedTokenTotal`
- 1.5x multiplier logic in `provideTokenCount()`
- `modelInfoChangeEmitter.fire()` call from error path

**Risk:** Loss of post-error recovery behavior

**Mitigation:**

- Rolling correction already handles systematic underestimation
- TokenCache provides actual token counts for known messages
- If needed, add explicit "too long" handling that clears correction state instead of inflating

**Tests:** No existing tests to update (none exercise this path)

**Expected outcome:** Summarization ping-pong eliminated (the direct cause is the lossy hash keeping the multiplier active across summarization boundaries)

### Phase 3: Consolidate Identity System

**Scope:** Replace `conversationId` with digest-based keying

> ⚠️ **BLOCKED on RFC 00051**
>
> This phase increases reliance on `model.family` for keying. If `family` derivation is broken, this phase amplifies cross-model contamination. RFC 00051 must land first.

**Depends on:**

- Phase 2 (or can proceed independently)
- **RFC 00051** (family parsing fix)

Changes:

- Remove `conversationIdentity` computation from `GatewayLanguageModelProvider`
- Remove `conversationId` parameter from `estimateConversation()` and `recordActualTokens()`
- Key `knownStates` by model family only (current fallback behavior)
- OR: Key by model family + message digest set (more precise)

**Risk:** Medium - has tests, changes state management

**Mitigation:**

- Model-family keying is already the fallback and works
- Digest-based matching in TokenCache handles per-message precision
- Update tests to validate new keying strategy
- **RFC 00051 ensures family is correct before we rely on it**

**Tests:** Update `hybrid-estimator.test.ts` tests that assert per-conversation behavior

### Phase 4: Error Recovery Redesign (Optional)

**Scope:** If post-error behavior is still needed, implement properly

#### The Gap (Documented 2026-02-06)

After removing the zombie 1.5x multiplier system:

- On "too long" error: We display the error in status bar, but don't adjust estimates
- Rolling correction only updates on **successful** requests via `recordActual()`
- Next request will use the same (too low) estimates → potential for repeated errors

**What the zombie code did (badly):**

- Stored `actualTokens` from error with a lossy conversation hash
- Applied 1.5x multiplier to ALL `provideTokenCount()` calls if hash matched
- Problems: lossy hash caused ping-pong, 1.5x was arbitrary, cross-conversation pollution

#### Options

**Option 1: Do Nothing (Observe)**

Rationale: VS Code may handle this itself. When a request fails with "too long", VS Code might:

- Automatically trigger summarization
- Retry with fewer messages
- Show user a prompt to reduce context

Risk: If VS Code doesn't handle it, users get stuck in error loops.

**Option 2: Clear Rolling Correction on Error**

```typescript
// In error handler, after extracting tokenInfo:
if (tokenInfo) {
  this.tokenEstimator.clearAdjustment(model.family);
}
```

Rationale: If we hit a token limit, our estimates were too low. Clearing the rolling correction resets to baseline tiktoken estimates, which are typically conservative (higher than actual).

Pros:

- Simple to implement
- No new state to track
- Conservative approach (higher estimates = safer)

Cons:

- Loses accumulated correction data
- May over-correct (estimates too high after reset)

**Option 3: Feed Error to Rolling Correction**

```typescript
// In error handler, after extracting tokenInfo:
if (tokenInfo && chatMessages) {
  this.tokenEstimator.recordActual(
    chatMessages,
    model,
    tokenInfo.actualTokens,
    conversationId,
    sequenceEstimate,
    false, // not summarization
  );
}
```

Rationale: The error response tells us the actual token count. We can use this to update rolling correction just like a successful response.

Pros:

- Uses existing infrastructure
- Correction is proportional to actual error
- No new mechanisms needed

Cons:

- Requires access to `chatMessages` in error handler
- May need to re-add message tracking (removed with zombie code)
- Error token counts may be less reliable than success counts

#### Recommendation

**Start with Option 1 (Do Nothing)** and observe behavior in production.

Rationale:

1. We don't know if this is actually a problem in practice
2. VS Code may already handle "too long" errors gracefully
3. Adding complexity without evidence of need violates YAGNI
4. If needed, Option 3 is the cleanest solution

**If issues are observed:** Implement Option 3 - it's the most architecturally sound because it uses the existing rolling correction mechanism rather than adding a parallel system.

## Migration Strategy

### Dependency Graph

```
┌─────────────────────────────────────────────────────────────────┐
│                        RFC 053                                   │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐  │
│  │  Phase 1    │───▶│  Phase 2    │    │      Phase 3        │  │
│  │ Dead code   │    │ 1.5x mult   │    │ conversationId GC   │  │
│  │ (safe)      │    │ (fixes      │    │ (family-only key)   │  │
│  │             │    │  ping-pong) │    │                     │  │
│  └─────────────┘    └─────────────┘    └──────────┬──────────┘  │
│                                                    │             │
└────────────────────────────────────────────────────┼─────────────┘
                                                     │ BLOCKED
                                                     ▼
                              ┌─────────────────────────────────────┐
                              │           RFC 00051                 │
                              │  Model Family String Mapping        │
                              │  - Fix claude-sonnet-4.5 parse bug  │
                              │  - Or: gateway authoritative family │
                              └─────────────────────────────────────┘
```

### Why Phase 3 Depends on RFC 00051

The `family` string flows through the replacement code:

1. **Rolling correction** uses `model.family` for keying `knownStates`
2. **Token counter** uses `family` for cache keys
3. **Tokenizer selection** uses fragile `family.includes("gpt-4o")` pattern

RFC 00051 identifies that `parseModelIdentity()` has a **parsing bug**:

- `claude-sonnet-4.5` is parsed as family `claude-sonnet` + version `4.5`
- This causes `claude-sonnet-4` and `claude-sonnet-4.5` to share the same family key
- Rolling correction state would leak between distinct models

If we remove `conversationId` (Phase 3) before fixing family:

- We'd be _increasing_ reliance on a broken system
- Models could cross-contaminate rolling correction state
- The cure would be worse than the disease

### Execution Order

| Step | RFC       | Phase | Description                              | Depends On          | Risk     |
| ---- | --------- | ----- | ---------------------------------------- | ------------------- | -------- |
| 1    | 053       | 1     | Remove `actualTokens` dead code          | Nothing             | None     |
| 2    | 053       | 2     | Remove 1.5x multiplier system            | Step 1 (or combine) | Low      |
| 3    | **00051** | -     | Fix `claude-sonnet-4.5` parsing          | Nothing             | Low      |
| 4    | 053       | 3     | Remove `conversationId`, use family-only | **Step 3**          | Medium   |
| 5    | 053       | 4     | Error recovery redesign (optional)       | Step 4              | Optional |

### Checkpoints

After **Step 2**:

- [ ] Summarization ping-pong eliminated
- [ ] All tests pass
- [ ] `learnedTokenTotal`, `hashConversation()` removed

After **Step 3** (RFC 00051):

- [ ] `claude-sonnet-4.5` parses as family `claude-sonnet-4.5` (not `claude-sonnet`)
- [ ] No model family collisions

After **Step 4**:

- [ ] `conversationId` removed from provider and estimator
- [ ] `knownStates` keyed by family only
- [ ] Tests updated

## Success Criteria

- [ ] Summarization ping-pong eliminated
- [ ] Single conversation identity system (normalized digest)
- [ ] No cross-conversation contamination
- [ ] All tests pass
- [ ] No dead code paths

## Open Questions

1. Does the error response from "prompt too long" include actual token counts we could use?
2. Should Phase 3 use model-family-only keying or model-family + digest-set?
3. Is there any production telemetry showing the 1.5x path being hit?
4. **For RFC 00051**: Should we wait for gateway authoritative family, or just fix the regex?

## References

- [Investigation: Summarization Ping-Pong](../investigation/summarization-ping-pong.md)
- **RFC 00051: Model Family String Mapping** (Phase 3 dependency)
- RFC 009: Reactive Error Learning (original introduction of zombie code)
- RFC 047: Rolling Correction
- RFC 052: Content-Hash Delta Caching (includes digest normalization)
- RFC 033: Conversation Tracking

**Note:** RFC 049 is assumption-validation, not digest unification. Digest normalization is part of RFC 052.

---

## Appendix: Intersection with RFC 00051

### Shared Code Paths

Both RFCs touch:

- `provider.ts` - conversation identity, family derivation
- `hybrid-estimator.ts` - rolling correction keying
- `tokens/counter.ts` - cache keying, tokenizer selection

### RFC 00051 Findings Relevant to This RFC

RFC 00051 identifies:

1. **`parseModelIdentity()` regex bug**: `claude-sonnet-4.5` → family `claude-sonnet` + version `4.5`
2. **Fragile tokenizer selection**: `resolveEncodingName()` uses `family.includes("gpt-4o")`
3. **Gateway could provide authoritative family**: `primaryModel` field already exists internally

### If RFC 00051's Gateway Changes Land First

- Phase 3 becomes safer (authoritative family eliminates collision risk)
- `resolveEncodingName()` heuristics could be replaced with gateway tokenizer metadata
- Family-only keying becomes a reliable simplification rather than a risky fallback
- Additional dead code may be surfaced (regex parsing becomes unnecessary)

### Minimum Viable Fix

If gateway changes are slow, RFC 00051's minimum fix is:

- Update `VERSION_PATTERN` regex to not match single-digit semver at end of model names
- This unblocks Phase 3 without waiting for gateway changes