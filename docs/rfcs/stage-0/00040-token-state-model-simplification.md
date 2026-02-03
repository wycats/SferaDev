---
title: Token State Model Simplification
stage: 0
feature: Token Tracking
exo:
    tool: exo rfc create
    protocol: 1
---

# RFC 00040: Token State Model Simplification

## Summary

This RFC proposes simplifying the token state model to reduce concept overlap and establish clear invariants.

## Motivation

The current token model has several issues:
1. `totalInputTokens` is misnamed - it's actually `Math.max()` of all turns, not a sum
2. `estimatedInputTokens` is never cleared on completion, leading to stale values
3. Too many overlapping concepts make it hard to reason about correctness
4. No clear separation between authoritative (OpenResponses) and estimated values

## Proposed Model

```typescript
interface TokenState {
  // Authoritative values from OpenResponses (last completed turn)
  inputTokens?: number;
  outputTokens?: number;
  
  // Model context window (stable per model)
  maxInputTokens?: number;
  
  // Multi-turn tracking
  turnCount?: number;
  totalOutputTokens?: number;  // cumulative output across turns
  maxObservedInputTokens?: number;  // renamed from totalInputTokens
  
  // Streaming estimate (only exists while streaming)
  currentEstimate?: {
    inputTokens: number;
    source: 'exact' | 'delta' | 'full';
  };
}
```

## Key Changes

1. **Rename `totalInputTokens` to `maxObservedInputTokens`** - reflects actual semantics (max, not sum)
2. **Introduce `currentEstimate` structure** - clearly separates estimate from actual
3. **Clear estimate on completion** - prevents stale values

## Invariants

1. `currentEstimate` exists only while status is streaming; cleared when actual arrives
2. `inputTokens` comes only from OpenResponses (authoritative)
3. `totalOutputTokens += outputTokens` on each completion
4. `turnCount` increments exactly once per completion
5. `maxObservedInputTokens = Math.max(maxObservedInputTokens, inputTokens)` on completion

## Display Invariant

**The displayed token value and the value used for percentage calculation MUST be identical.**

- If using an estimate (streaming), percentage MUST use the same estimate
- For multi-turn conversations, accumulated totals MUST be used consistently

## Migration

1. Rename field in `AgentEntry` interface
2. Update all usages
3. Add `currentEstimate` structure
4. Clear estimate in `completeAgent()`

