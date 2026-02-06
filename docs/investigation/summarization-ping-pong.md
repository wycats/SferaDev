# Summarization Ping-Pong Investigation

## TL;DR

VS Code's chat conversation gets summarized, then after just one turn, it gets summarized again. ~~RFC 047 already identified the likely cause: the `learnedTokenTotal` 1.5x multiplier mechanism doesn't clear fast enough after summarization.~~ **UPDATE**: The root cause is deeper - there are **3 incompatible identity/hashing schemes** coexisting from different eras of development. The 1.5x multiplier and its lossy hash are zombie code from RFC 009 that predates modern tracking mechanisms. The lossy hash (first 2 + last 2 messages) can remain stable across summarization, keeping the multiplier active. Next action: **GC the zombie code** and consolidate on the modern digest/identity system before attempting behavioral fixes.

## Zombie Code Analysis (2026-02-06)

### The Three Identity Systems

| Era     | Mechanism                  | Location            | Hash Method                  | Introduced | Status    |
| ------- | -------------------------- | ------------------- | ---------------------------- | ---------- | --------- |
| Legacy  | `learnedTokenTotal` + 1.5x | provider.ts         | First 2 + last 2 messages    | RFC 009    | 🧟 ZOMBIE |
| Legacy  | `conversationId`           | hybrid-estimator.ts | Model + first user message   | Unknown    | 🧟 ZOMBIE |
| Current | `computeNormalizedDigest`  | digest.ts           | Full message, normalized     | RFC 049    | ✅ ACTIVE |
| Current | `conversationIdentity`     | status-bar.ts       | First user + first assistant | RFC 033    | ✅ ACTIVE |
| Current | TokenCache                 | cache.ts            | Uses normalized digest       | RFC 052    | ✅ ACTIVE |

### Why This Causes Ping-Pong

The `hashConversation()` function (used by 1.5x multiplier) only looks at first 2 + last 2 messages:

```typescript
const relevant = [...messages.slice(0, 2), ...messages.slice(-2)];
```

**If summarization changes only middle messages, this hash doesn't change.**

The 1.5x multiplier stays active, inflates token counts, and triggers another summarization.

### The 1.5x Multiplier Origin Story

- **RFC 009** (Reactive Error Learning): After "prompt too long" error, the only signal we have is the error itself. No successful response = no actual token counts = no rolling correction.
- **Purpose**: Inflate estimates on retry so VS Code's summarization triggers.
- **Problem**: It predates:
  - Delta estimation (RFC 029)
  - Rolling correction (RFC 047)
  - Normalized digest unification (RFC 049)
  - TokenCache (RFC 052)
  - Conversation tracker (RFC 033)

### Candidate Zombie Code for GC

1. **`hashConversation()` in provider.ts** - lossy hash, superseded by normalized digest
2. **`learnedTokenTotal` + 1.5x multiplier** - isolated error path, conflicts with modern mechanisms
3. **`conversationId` in hybrid-estimator.ts** - weak identity (model + first user), can collide

---

## Zombie Code Inventory (GC RFC Preparation)

### Zombie 1: `learnedTokenTotal` + 1.5x Multiplier

**Locations:**

- Declaration: [provider.ts](apps/vscode-ai-gateway/src/provider.ts) - `learnedTokenTotal` field
- Set on error: [provider.ts](apps/vscode-ai-gateway/src/provider.ts) - "too long" error parsing
- Cleared on success: [provider.ts](apps/vscode-ai-gateway/src/provider.ts) - `if (result.success)`
- Applied in `provideTokenCount()`: [provider.ts](apps/vscode-ai-gateway/src/provider.ts) - 1.5x multiplier
- Depends on: `hashConversation()`, `hashChatMessage()`

**What It Does:**

- State: `{ conversationHash, actualTokens }`
- Hashing: First 2 + last 2 messages, truncated hash
- Write trigger: "prompt too long" API error
- Read trigger: `provideTokenCount()` checks hash match, applies 1.5x
- Note: `actualTokens` is only logged, never used in calculations

**Original Purpose:**

- RFC 009: Reactive error learning to force VS Code summarization after API error
- RFC 047: Kept as "fallback" even with rolling correction

**Why It's Zombie:**

- Superseded by: rolling correction + delta estimation + TokenCache
- Uses lossy hash incompatible with normalized digest system
- `actualTokens` field is dead code (logged only)
- Lossy hash doesn't detect summarization → causes ping-pong

**Entanglements:**

- Depends on `hashConversation()`, `hashChatMessage()`, error parsing
- **No tests exercise this path**

**Replacement Strategy:**

- Remove entirely
- If error recovery needed: use rolling correction mechanism with modern digest-based state

---

### Zombie 2: `hashConversation()` (Lossy Hash)

**Locations:**

- Definition: [provider.ts](apps/vscode-ai-gateway/src/provider.ts) - `hashConversation()`
- Used by: `learnedTokenTotal` setting and matching
- Uses: `hashChatMessage()` for per-message hashing

**What It Does:**

```typescript
const relevant = [...messages.slice(0, 2), ...messages.slice(-2)];
```

- Takes first 2 + last 2 messages only
- Produces truncated hash for "conversation identity"

**Original Purpose:**

- Provide stable identifier for reactive error learning (RFC 009 era)

**Why It's Zombie:**

- Only used by `learnedTokenTotal` path
- Incompatible with modern digest system
- Lossy: stable across summarization if only middle messages change
- **This is the direct cause of ping-pong**

**Entanglements:**

- Only tied to `learnedTokenTotal` path
- **No direct tests**

**Replacement Strategy:**

- Remove along with `learnedTokenTotal`
- If conversation hash needed: use digest-based identity from `computeNormalizedDigest()`

---

### Zombie 3: `conversationId` in HybridTokenEstimator

**Locations:**

- Identity generation: [hybrid-estimator.ts](apps/vscode-ai-gateway/src/tokens/hybrid-estimator.ts) - `getConversationId()`
- Provider passes identity: [provider.ts](apps/vscode-ai-gateway/src/provider.ts) - `conversationIdentity`
- Estimator uses for lookup: [hybrid-estimator.ts](apps/vscode-ai-gateway/src/tokens/hybrid-estimator.ts) - `knownStates.get()`
- Fallback comment: [hybrid-estimator.ts](apps/vscode-ai-gateway/src/tokens/hybrid-estimator.ts) - "provideTokenCount() doesn't have access to conversationId"

**What It Does:**

- State: in-memory map keyed by `modelId:firstUserHash` → generates `conversationId`
- Falls back to model-family-only keys when `conversationId` unavailable
- Used to scope rolling correction and conversation state

**Original Purpose:**

- RFC 047: Avoid cross-conversation contamination for rolling correction

**Why It's Zombie:**

- Weak identity: only first user message, ignores edits/summarization/branching
- Collisions: two conversations with same first user prompt share ID
- Incompatible with digest-based message matching already in TokenCache
- Model-family fallback reintroduces cross-conversation contamination

**Entanglements:**

- `knownStates` keying and tests assume this scheme
- LRU size accounting depends on per-conversation entries
- Tests in [hybrid-estimator.test.ts](apps/vscode-ai-gateway/src/tokens/hybrid-estimator.test.ts)

**Replacement Strategy:**

- Remove `conversationId` plumbing
- Key `knownStates` by model family + normalized message digests
- Update tests to validate digest-based matching

---

## Non-Zombie Identity Systems (Keep)

| System                          | Location      | Purpose                              | Status        |
| ------------------------------- | ------------- | ------------------------------------ | ------------- |
| `computeNormalizedDigest()`     | digest.ts     | Per-message identity for cache/delta | ✅ CURRENT    |
| `computeConversationIdentity()` | status-bar.ts | UI agent tracking                    | ✅ CURRENT    |
| `computeAgentTypeHash()`        | hash-utils.ts | Parent-child linking                 | ✅ CURRENT    |
| `computeChatHash()`             | provider.ts   | Logging only                         | ✅ DIAGNOSTIC |

---

## Duplication/Conflict Summary

| Conflict                | Old System                    | New System                  | Risk            |
| ----------------------- | ----------------------------- | --------------------------- | --------------- |
| Conversation identity   | `hashConversation()` (lossy)  | `computeNormalizedDigest()` | Ping-pong       |
| Per-conversation keying | `conversationId` (first user) | Digest-based matching       | Collisions      |
| Error correction        | 1.5x multiplier               | Rolling correction          | Competing paths |

### Conflict Points

1. **Summarization vs lossy hash**: Hash doesn't change if only middle messages change
2. **Multiple incompatible identities**:
   - `hashConversation()` includes name + content shapes
   - `computeNormalizedDigest()` strips call IDs, names, URLs
   - `conversationIdentity` uses first user + first assistant only
3. **Conversation ID collisions**: Two conversations with same first user prompt share `conversationId`

## Invariants

These MUST be true for correct summarization behavior:

### INV-1: `learnedTokenTotal` cleared before next `provideTokenCount()` sequence

**Statement**: After successful summarization, `learnedTokenTotal` MUST be cleared before the next `provideTokenCount()` call sequence.

**Logical Chain**:

- `learnedTokenTotal` inflates per-message token estimates by 1.5x inside `provideTokenCount()`
- If it persists after summarization, the _next_ per-message sequence can still look "too large," triggering another summarization ("ping-pong")
- Therefore it must be cleared _before_ the next `provideTokenCount()` sequence that follows summarization

**Status**: ⚠️ PARTIALLY ENFORCED

**Evidence**:

- Setting: [provider.ts](apps/vscode-ai-gateway/src/provider.ts) - on "too long" error
- Multiplier: [provider.ts](apps/vscode-ai-gateway/src/provider.ts) - `if (currentHash === this.learnedTokenTotal.conversationHash)`
- Clearing: [provider.ts](apps/vscode-ai-gateway/src/provider.ts) - only on successful request completion

**Gap**: No explicit clearing tied to summarization detection _before_ the next `provideTokenCount()` sequence. If VS Code re-queries token counts immediately after `modelInfoChangeEmitter.fire()`, the 1.5x multiplier can still apply.

---

### INV-2: Post-summarization token sum below `maxInputTokens`

**Statement**: The sum of `provideTokenCount()` returns for a summarized conversation MUST be less than `maxInputTokens`.

**Logical Chain**:

- Summarization is intended to reduce the context below the model limit
- If summed per-message estimates still exceed `maxInputTokens`, VS Code can immediately summarize again

**Status**: ❌ NOT ENFORCED

**Evidence**:

- `provideTokenCount()` applies a 1.5x multiplier without any cap
- No code guarantees post-summarization totals stay below `maxInputTokens`

**Gap**: The multiplier can force even summarized contexts above the limit. No cap or "summarization-aware" override.

---

### INV-3: `hasSummarizationTag()` detects `<conversation-summary>`

**Statement**: `hasSummarizationTag()` MUST return `true` when `<conversation-summary>` is present in messages.

**Logical Chain**:

- `hasSummarizationTag()` gates the summarization guard that clears rolling correction
- If it misses the tag, stale correction persists and can distort counts post-summarization

**Status**: ✅ ENFORCED (with tests)

**Evidence**:

- Tag detection: [status-bar.ts](apps/vscode-ai-gateway/src/status-bar.ts) - checks user text parts
- Tests: [status-bar.test.ts](apps/vscode-ai-gateway/src/status-bar.test.ts)

**Gap**: Detection only checks user message text parts. If `<conversation-summary>` appears in non-text parts or assistant messages, it will not be detected (by design).

---

### INV-4: Conversation hash changes after summarization

**Statement**: Conversation hash MUST change after summarization (first user message changes to summary).

**Logical Chain**:

- `learnedTokenTotal` is scoped by a conversation hash
- If the hash does not change after summarization, the 1.5x multiplier can persist into the summarized conversation

**Status**: ⚠️ PARTIALLY ENFORCED

**Evidence**:

- Hash uses first two and last two messages: [provider.ts](apps/vscode-ai-gateway/src/provider.ts) - `hashConversation()`
- Conversation identity derived from first user message hash: [status-bar.ts](apps/vscode-ai-gateway/src/status-bar.ts)

**Gap**: If summarization only alters messages outside the first two or last two positions, the hash may not change. If `currentRequestMessages` is stale at the time `provideTokenCount()` runs, the hash comparison may still pass even after summarization.

---

### INV-5: Rolling correction cleared on summarization detection

**Statement**: Rolling correction adjustment MUST be cleared when summarization is detected.

**Logical Chain**:

- Rolling correction is applied to the first message of each `provideTokenCount()` sequence
- If it survives summarization, the next sequence can be inflated and re-trigger summarization

**Status**: ⚠️ PARTIALLY ENFORCED

**Evidence**:

- Detection: [provider.ts](apps/vscode-ai-gateway/src/provider.ts) - `hasSummarizationTag(chatMessages)`
- Guard clears state: [hybrid-estimator.ts](apps/vscode-ai-gateway/src/tokens/hybrid-estimator.ts) - writes fresh `familyState`
- Tests: [hybrid-estimator.test.ts](apps/vscode-ai-gateway/src/tokens/hybrid-estimator.test.ts)

**Gap**: The guard runs only when `recordActualTokens()` is called (after a successful request with usage data). The _next_ `provideTokenCount()` sequence can still see stale adjustment before the post-summary request completes.

## Architecture Map

### What triggers summarization?

- **Owner**: Copilot Chat extension (not the gateway)
- **Trigger**: When sum of `provideTokenCount()` returns approaches `maxInputTokens`
- **Component**: `SummarizedConversationHistory` in `vscode-copilot-chat`
- **Threshold**: ~85% of `maxInputTokens` (configurable in Copilot)

### What state does summarization consume?

- Full conversation history (all messages)
- Model's `maxInputTokens` metadata
- Per-message token counts from `provideTokenCount()`

### What state does summarization produce?

- `<conversation-summary>` XML tag as first user message
- Reduced message array (old messages dropped)
- New conversation identity (first user message hash changes)

### How does VS Code's LM API handle context windows?

```
provideTokenCount(msg) × N  →  sum  →  compare to maxInputTokens
                                              ↓
                                    if sum > threshold
                                              ↓
                                    trigger summarization
```

### Where could the "one turn then summarize again" loop emerge?

**Primary Suspect: `learnedTokenTotal` 1.5x multiplier**

Location: [provider.ts](apps/vscode-ai-gateway/src/provider.ts) (search for `learnedTokenTotal`)

```typescript
if (this.learnedTokenTotal && this.currentRequestMessages) {
  const currentHash = this.hashConversation(this.currentRequestMessages);
  if (currentHash === this.learnedTokenTotal.conversationHash) {
    // Apply a 1.5x multiplier to compensate for the underestimate
    const inflated = estimate * 1.5;
    return Promise.resolve(Math.ceil(inflated));
  }
}
```

**The Loop Mechanism:**

1. Request fails with "input too long" error
2. `learnedTokenTotal` is set with conversation hash
3. `modelInfoChangeEmitter.fire()` triggers VS Code to re-query token counts
4. 1.5x multiplier applied → VS Code sees inflated counts → triggers summarization
5. Summarization succeeds → `learnedTokenTotal` cleared on success
6. **BUT**: If conversation hash doesn't change (edge case), multiplier persists
7. Next turn: multiplier still applied → inflated counts → summarization again

**Clearing Logic:**

```typescript
if (result.success) {
  // Clear learned token total on success
  if (this.learnedTokenTotal) {
    this.learnedTokenTotal = null;
  }
}
```

**Potential Gap**: Clearing happens on success, but:

- Does summarization count as a "successful request"?
- Is the hash comparison correct after summarization?
- Is there a race between clearing and the next `provideTokenCount()` sequence?

### Key Files

| File                                                                         | Role                                                            |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [provider.ts](apps/vscode-ai-gateway/src/provider.ts)                        | Main provider, `learnedTokenTotal` state, `provideTokenCount()` |
| [status-bar.ts](apps/vscode-ai-gateway/src/status-bar.ts)                    | `hasSummarizationTag()`, conversation tracking                  |
| [hybrid-estimator.ts](apps/vscode-ai-gateway/src/tokens/hybrid-estimator.ts) | Delta estimation, rolling correction                            |
| [turn-detector.ts](apps/vscode-ai-gateway/src/tokens/turn-detector.ts)       | Turn boundary detection (500ms gap)                             |

## Hypothesis Registry

**Workflow Note**: When a hypothesis is REFUTED or CONFIRMED, it MUST include:

1. Complete chain of evidence (file:line references)
2. Verification by a fresh recon or review agent
3. The specific prediction that was tested and the observed result

| ID  | Hypothesis                                                                       | Prediction                                                                   | Status   | Evidence                                                                 |
| --- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| H1  | `learnedTokenTotal` not cleared fast enough after summarization                  | If true, we'd see 1.5x multiplier applied to post-summarization messages     | UNTESTED | RFC 047 suggests this is likely                                          |
| H2  | Conversation hash doesn't change after summarization                             | If true, `learnedTokenTotal` would persist across summarization boundary     | UNTESTED | Need to verify hash computation includes summary message                 |
| H3  | Rolling correction applies stale adjustment post-summarization                   | If true, we'd see non-zero adjustment after `<conversation-summary>` appears | REOPENED | See H3 Review below - "key mismatch" claim is incorrect                  |
| H4  | `maxInputTokens` mismatch (128k vs 200k) causes premature summarization          | If true, we'd see summarization at ~100k when model can handle 200k          | PARTIAL  | RFC 044 documents this, but it causes early summarization, not ping-pong |
| H5  | Summarization request itself triggers another summarization                      | If true, we'd see summarization during the summarization LLM call            | UNTESTED | Copilot uses same model for summarization                                |
| H6  | `modelInfoChangeEmitter.fire()` triggers immediate re-evaluation before clearing | If true, VS Code queries tokens before `learnedTokenTotal` is cleared        | UNTESTED | Race condition between fire() and success handling                       |

## Open Questions

| Priority | Question                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------ |
| HIGH     | Does `hashConversation()` include the `<conversation-summary>` message? If not, hash may not change after summarization. |
| HIGH     | What is the exact timing between `modelInfoChangeEmitter.fire()` and success clearing?                                   |
| HIGH     | Does Copilot's summarization request go through our `provideLanguageModelResponse()`?                                    |
| MED      | Is there logging that shows the sequence: summarize → one turn → summarize again?                                        |
| MED      | What does the conversation hash look like before/after summarization?                                                    |
| LOW      | Does the 1.5x multiplier need to be conversation-hash-scoped, or should it be cleared on ANY summarization detection?    |

## Session Log

### 2026-02-06 - Initial Setup

- Created investigation document
- Documented known invariants and initial hypotheses from RFC 047 analysis
- Mapped architecture from RFC 047, RFC 044, and codebase analysis
- Key finding: RFC 047 already identified `learnedTokenTotal` as likely cause
- Key finding: Rolling correction (H3) is refuted - it's currently inert due to key mismatch
- Identified 6 hypotheses, 1 already refuted (H3), 1 partial (H4)
- Next step: Verify H1 (multiplier timing) and H2 (hash change across summarization)

### 2026-02-06 - Invariant Review (Review Agent)

- Reviewed all 5 invariants with fresh eyes
- **Critical finding**: H3 refutation is INCORRECT
  - The "key mismatch" claim is not supported by current code
  - `recordActualTokens()` explicitly writes a model-family key so `getAdjustment()` can find it
  - Rolling correction IS ACTIVE, not inert
- Invariant status:
  - INV-1: ⚠️ PARTIALLY ENFORCED - only cleared on success, not before next sequence
  - INV-2: ❌ NOT ENFORCED - 1.5x multiplier has no cap
  - INV-3: ✅ ENFORCED with tests
  - INV-4: ⚠️ PARTIALLY ENFORCED - hash is lossy, may not change in all cases
  - INV-5: ⚠️ PARTIALLY ENFORCED - guard runs after request, stale adjustment can apply before
- H3 status changed: REFUTED → REOPENED
- Next step: Investigate INV-2 gap (1.5x multiplier without cap)

### 2026-02-06 - Zombie Code Discovery (Recon Agent)

- Mapped ALL conversation tracking mechanisms in codebase
- **Critical finding**: 3 incompatible identity/hashing schemes coexist
  1. Legacy: `hashConversation()` (first 2 + last 2 messages) - RFC 009
  2. Legacy: `conversationId` (model + first user) - no RFC
  3. Current: normalized digest system - RFC 049/052
- The 1.5x multiplier is zombie code from RFC 009 that predates all modern mechanisms
- **Root cause of ping-pong**: lossy hash doesn't detect summarization if only middle messages change
- Identified 3 candidates for GC:
  1. `hashConversation()` - superseded by normalized digest
  2. `learnedTokenTotal` + 1.5x - isolated, conflicts with modern mechanisms
  3. `conversationId` in estimator - weak, can collide
- Next step: Create RFC to GC zombie code and consolidate on modern identity system

### 2026-02-06 - Zombie Code Deep Dive (Recon Agent)

- Full inventory of 3 zombie code areas:
  1. `learnedTokenTotal` + 1.5x multiplier + `hashConversation()` (RFC 009)
  2. `conversationId` in hybrid-estimator (weak first-user identity)
  3. `hashChatMessage()` (only used by zombie paths)
- Key findings:
  - **`actualTokens` in `learnedTokenTotal` is dead code** - only logged, never used
  - **No tests exercise the 1.5x multiplier path**
  - `conversationId` collides across conversations with same first user message
  - Model-family fallback reintroduces the cross-conversation contamination it was meant to prevent
- Confirmed non-zombie systems:
  - `computeNormalizedDigest()` - current architecture
  - `computeConversationIdentity()` - UI tracking
  - TokenCache - uses normalized digests
- Next step: Draft RFC for zombie GC

### 2026-02-06 - RFC 053 Drafted and Reviewed

- Created RFC 053: Zombie Identity System GC (`docs/rfcs/stage-0/053-zombie-identity-gc.md`)
- Review agent verified RFC against codebase, found inconsistencies:
  - ❌ `hashChatMessage()` doesn't exist → corrected to `simpleHash()`
  - ❌ `computeConversationIdentity()` doesn't exist → corrected to `getConversationIdentity()`
  - ❌ RFC 049 is assumption-validation, not digest unification → corrected reference
  - ⚠️ `conversationId` is computed in provider, not estimator → clarified
- RFC corrected and ready for stage 0→1 review
- Next step: User review of RFC phasing and approach

### 2026-02-06 - RFC 00051 Dependency Analysis

- Analyzed intersection between RFC 053 and RFC 00051 (Model Family String Mapping)
- Key finding: `family` flows through both zombie code and replacement code
  - Rolling correction: `knownStates` keyed by `model.family`
  - Token counter: cache keys use `family`
  - Tokenizer selection: fragile `family.includes("gpt-4o")` pattern
- RFC 00051 identifies `parseModelIdentity()` parsing bug:
  - `claude-sonnet-4.5` → family `claude-sonnet` + version `4.5`
  - Would cause model collision in rolling correction
- **RFC 053 Phase 3 BLOCKED on RFC 00051**:
  - Phase 3 increases reliance on family-only keying
  - If family is broken, Phase 3 amplifies cross-model contamination
  - Must fix family parsing before Phase 3
- Updated RFC 053 with:
  - Dependencies section with blocking notice
  - Detailed dependency graph
  - Execution order table
  - Checkpoints after each step
  - Appendix on RFC 00051 intersection
- Next step: Implement RFC 00051 minimal fix, then RFC 053 Phase 1-2

---

## H3 Review (2026-02-06)

**H3**: Rolling correction applies stale adjustment post-summarization.

**Original Status**: REFUTED due to "key mismatch"

**Reviewed Status**: REOPENED - the refutation was incorrect.

### Evidence Chain

1. **`provideTokenCount()` calls `estimateConversation()`** → rolling correction may apply on first message
   - Location: [provider.ts](apps/vscode-ai-gateway/src/provider.ts)

2. **`estimateConversation()` applies `getAdjustment()` to the first message in a sequence**
   - Location: [hybrid-estimator.ts](apps/vscode-ai-gateway/src/tokens/hybrid-estimator.ts)

   ```typescript
   const adjustment = isFirstInSequence
     ? this.getAdjustment(model.family, conversationId)
     : 0;
   ...
   finalEstimate = estimate + adjustment;
   ```

3. **`getAdjustment()` reads from model-family state**
   - Location: [hybrid-estimator.ts](apps/vscode-ai-gateway/src/tokens/hybrid-estimator.ts)

4. **`recordActualTokens()` writes a model-family key specifically for this path**
   - Location: [hybrid-estimator.ts](apps/vscode-ai-gateway/src/tokens/hybrid-estimator.ts)

   ```typescript
   // provideTokenCount() doesn't have access to conversationId, so getAdjustment()
   // reads from the model-family-only key.
   ...
   this.knownStates.set(familyKey, familyState);
   ```

5. **Summarization guard clears `familyState` only after a successful post-summary request**
   - Location: [hybrid-estimator.ts](apps/vscode-ai-gateway/src/tokens/hybrid-estimator.ts)

### Conclusion

- The "key mismatch" claim from RFC 047 is **not supported** by current code
- Rolling correction is ACTIVE, not inert
- The guard clears it _after_ a successful post-summary request, but stale adjustment can still apply to the immediately following `provideTokenCount()` sequence
- **H3 remains a valid hypothesis** - needs empirical verification
