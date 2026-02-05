---
title: Gateway vs VS Code Token Limit Mismatch
stage: 0
feature: Unknown
exo:
    tool: exo rfc create
    protocol: 1
---

# RFC 00044: Gateway vs VS Code Token Limit Mismatch

## Stage: 0 (Idea)

## Summary

Vercel AI Gateway allows up to 200k input tokens for Claude Opus 4.5, but we report `maxInputTokens: 128000` to VS Code due to conservative limits for quality. This creates a display mismatch where:

1. The API happily accepts 170k+ tokens
2. Status bar shows 170k/128k (appears to be "over limit")
3. VS Code's compaction triggers at 128k instead of the actual 200k limit

This is not a bug, but reveals gaps in our thinking about compaction timing and VS Code assumptions.

## Context

### Current Implementation

```
Vercel Gateway API
     │
     │ context_window: 200000
     │
     ▼
models.ts (transform)
     │
     │ Math.min(context_window, CONSERVATIVE_MAX_INPUT_TOKENS)
     │ = Math.min(200000, 128000)
     │ = 128000
     │
     ▼
VS Code sees maxInputTokens: 128000
     │
     ├──► Copilot's SummarizedConversationHistory triggers at ~128k
     ├──► Status bar shows usage/128k
     └──► Provider warns if estimated > 128k
```

### Why We Cap at 128k

From [constants.ts](../../packages/vscode-ai-gateway/src/constants.ts#L25):

> Research shows that LLM performance degrades significantly as context approaches advertised limits ("context rot"). Models may announce intent to use tools but fail to actually call them, or produce lower-quality outputs.

This is documented in [RFC 019](./019-high-context-tool-call-failure.md) where we observed "pause" behavior at 130k+ tokens.

### The Problem Observed

When the user saw `170k/107k` in the status bar:

1. **170k is real** - The API returned `usage.input_tokens: 174337`
2. **This is valid** - Vercel's limit is 200k, not 128k
3. **But it looks wrong** - Because we told VS Code max is 128k

The status bar correctly shows what the API reported, but against a limit that doesn't match reality.

## Analysis

### Gap 1: VS Code Compaction Triggers Too Early

**What happens:**
- VS Code sees `maxInputTokens: 128000`
- At ~100k tokens, VS Code starts summarizing conversation history
- But the model could actually handle 200k before failing

**Is this a problem?**
- **For quality:** No - RFC 019 shows degradation at 130k+
- **For capacity:** Yes - We're leaving 70k tokens on the table
- **For cost:** Maybe - Summarization costs tokens too

**Trade-off:** Earlier compaction = better quality but less context capacity.

### Gap 2: Display Shows Nonsensical Numbers

**What happens:**
- API returns `input_tokens: 174337`
- Status bar shows `174k/128k (136%)` or similar
- User sees "over limit" when requests are succeeding

**Is this a problem?**
- **Confusing:** Yes - the numbers don't make sense
- **Misleading:** User might think something is broken
- **Technically correct:** We're showing actual usage vs reported limit

### Gap 3: Token Tracking Across Compaction

When VS Code summarizes, it creates a synthetic message that replaces N older messages. This means:

1. `firstUserMessageHash` may change (new "first" message after summary)
2. Our agent identity could fragment (new conversation hash)
3. Token counts reset but context doesn't (summary is smaller)

This was partially addressed by identity axiom changes, but may still cause issues.

## Potential Solutions

### Option A: Report Actual Gateway Limit (200k)

```typescript
// models.ts - DON'T cap
maxInputTokens: model.context_window  // 200000
```

**Pros:**
- Display makes sense
- Uses full capacity

**Cons:**
- Hits context rot territory
- More "pause" failures at high context

### Option B: Keep Conservative but Fix Display

Show two limits:

```
Status bar: 170k/200k (85%) [conservative: 128k exceeded]
```

**Pros:**
- Clear what's happening
- Preserves early compaction trigger

**Cons:**
- Complicated display
- Mixed messaging

### Option C: Dynamic Limit Based on Behavior

```typescript
// Start conservative
let effectiveLimit = CONSERVATIVE_MAX_INPUT_TOKENS; // 128k

// If model succeeds at high context, relax
if (successfulAt170k && noQualityDegradation) {
  effectiveLimit = 200000;
}
```

**Pros:**
- Adapts to actual behavior
- Best of both worlds

**Cons:**
- Complex to implement
- Hard to detect "quality degradation"

### Option D: Accept the Mismatch (Document Only)

Keep current behavior but:

1. Document that displayed "over limit" is expected when near conservative cap
2. Add tooltip explaining conservative vs actual limits
3. Accept that compaction triggers earlier than strictly necessary

**Pros:**
- Minimal code change
- Honest about the trade-off

**Cons:**
- Still confusing display
- Leaves capacity on table

## Recommendation

**Option D** (accept and document) for now, with these improvements:

1. **Tooltip Enhancement:** When usage > conservative limit but < actual limit:
   ```
   ⚠️ Context exceeds quality threshold (128k) but within API limit (200k)
   VS Code may summarize to maintain response quality
   ```

2. **Color Coding:** 
   - Green: < 75% of conservative
   - Yellow: 75-100% of conservative  
   - Orange: > conservative but < actual (quality warning)
   - Red: > actual limit (will fail)

3. **Future Work:** Investigate Option C (dynamic limits) if we can reliably detect context rot.

## Related Work

- [RFC 009](./009-token-counting-context-management.md) - Token counting infrastructure
- [RFC 019](./019-high-context-tool-call-failure.md) - High-context failure patterns
- [RFC 029](./029-hybrid-token-estimator.md) - Hybrid token estimation

## Open Questions

1. **Should we surface the raw `context_window` to users?** Currently hidden behind conservative cap.

2. **Does VS Code's compaction actually use our `maxInputTokens`?** Need to verify Copilot's summarization trigger point.

3. **What's the optimal conservative limit?** 128k was chosen based on limited evidence. Should we collect more data?

4. **Can we detect context rot automatically?** "Pause" behavior, low output tokens, missing tool calls could be signals.
