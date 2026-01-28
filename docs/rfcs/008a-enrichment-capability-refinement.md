# RFC 008a: Enrichment-Based Capability Refinement

**Status**: ✅ Partially Implemented  
**Created**: 2026-01-28  
**Updated**: 2026-01-28  
**Parent RFC**: [RFC 008: High-Fidelity Model Mapping](./008-high-fidelity-model-mapping.md)

## Summary

Refine VS Code's `LanguageModelChatInformation` capabilities and token limits using enriched model metadata fetched from Vercel AI Gateway's enrichment endpoint. This leverages the infrastructure built in RFC 008 Phase 5 to provide more accurate capability declarations and token limits than the tag-based inference currently used.

## Motivation

### Current State (✅ Updated 2026-01-28)

RFC 008 Phase 5 implemented the `ModelEnricher` class that fetches per-model metadata including:

- `context_length`: Total context window size
- `max_completion_tokens`: Maximum output tokens
- `input_modalities`: Supported input types (e.g., `["text", "image"]`)
- `supported_parameters`: Model-specific parameters
- `supports_implicit_caching`: Prompt caching support

**Implementation status:**

- ✅ Enrichment data is fetched via `ModelEnricher` ([models/enrichment.ts](../../apps/vscode-ai-gateway/src/models/enrichment.ts))
- ✅ Enrichment is applied to model list in `applyEnrichmentToModels()` ([provider.ts#L150-L181](../../apps/vscode-ai-gateway/src/provider.ts#L150-L181))
- ✅ `onDidChangeLanguageModelChatInformation` fires after enrichment to refresh VS Code
- ✅ Configuration toggle exists (`models.enrichmentEnabled`)

1. `provideLanguageModelChatInformation()` calls `ModelsClient.getModels()` which returns models with:
   - `maxInputTokens` from `context_window` field (already accurate from `/v1/models`)
   - `capabilities.imageInput` derived from tag inference (e.g., "vision", "multimodal" tags)
2. Enrichment only happens later in `provideLanguageModelChatResponse()` via `enrichModelIfNeeded()`—**after** the model picker has already displayed

3. The enriched `input_modalities` data (authoritative) is never used to update the tag-based `capabilities.imageInput` inference

### Problems This Solves

1. **Unreliable Capability Detection**: Tag-based inference for `capabilities.imageInput` depends on models having correct tags. The enrichment endpoint's `input_modalities` field is authoritative and should take precedence.

2. **No Capability Refresh**: Once VS Code receives model information, there's no mechanism to update it when enrichment completes. Models may show incorrect capabilities until extension restart.

3. **Configuration Rigidity**: No way to disable enrichment if it causes issues or for debugging.

## Detailed Design

### Architecture Overview

**Current flow (as implemented today):**

1. `provideLanguageModelChatInformation()` calls `ModelsClient.getModels(apiKey)`
2. `ModelsClient.transformToVSCodeModels()` returns `LanguageModelChatInformation[]` with tag-based capability inference
3. Enrichment happens later in `provideLanguageModelChatResponse()` via `enrichModelIfNeeded()`

```
Extension Activation
  ↓
User opens model picker
  ↓
provider.provideLanguageModelChatInformation()
  ↓
ModelsClient.getModels(apiKey)
  ↓
ModelsClient.transformToVSCodeModels() [tag-based capabilities]
  ↓
VS Code displays picker
  ↓
Later: provider.provideLanguageModelChatResponse()
  ↓
enrichModelIfNeeded()
```

The RFC proposes two viable ways to apply enrichment to the model list:

### Approach A: Inline Enrichment

**Strategy**: Enrich inside `ModelsClient.getModels()` (or immediately after) before returning to `provideLanguageModelChatInformation()`.

**Pros**:

- Model list is already accurate when displayed
- No event plumbing required

**Cons**:

- Slower model picker (blocking on enrichment)
- Risk of timeouts or partial results

**When to use**: If accuracy is more important than picker latency.

### Approach B: Event-Based Refresh (Recommended)

**Strategy**: Return tag-based models quickly, then enrich asynchronously and notify VS Code via `onDidChangeLanguageModelChatInformation` so it re-queries updated capabilities.

**Pros**:

- Fast initial model picker
- Accurate capabilities once enrichment completes

**Cons**:

- Requires event wiring
- Two-step update (initial + refresh)

**When to use**: If responsiveness is the priority (recommended default).

### Configuration (✅ Implemented)

Setting exists to enable/disable enrichment ([config.ts](../../apps/vscode-ai-gateway/src/config.ts), [package.json](../../apps/vscode-ai-gateway/package.json)):

```json
{
  "vercelAiGateway.models.enrichmentEnabled": {
    "type": "boolean",
    "default": true,
    "description": "Fetch per-model metadata to refine capabilities and token limits"
  }
}
```

Add a typed accessor in `ConfigService`:

```typescript
get modelsEnrichmentEnabled(): boolean {
  return this.config.get("models.enrichmentEnabled", true);
}
```

**Use Cases**:

- Disable for debugging capability issues
- Disable if enrichment endpoint is unreachable
- Disable to test fallback behavior

### Token Limit Handling (✅ Implemented)

The implementation maps `/v1/models` `context_window` directly to `maxInputTokens` in `ModelsClient.transformToVSCodeModels()`. Enrichment `context_length` overrides are applied in `applyEnrichmentToModels()` ([provider.ts#L150-L181](../../apps/vscode-ai-gateway/src/provider.ts#L150-L181)).

### Image Capability Detection

The enrichment `input_modalities` field indicates supported input types:

`capabilities.imageInput` is a boolean in the current codebase (see `models.ts`).

```typescript
// Examples from enrichment API:
// text-only: { input_modalities: ["text"] }
// vision: { input_modalities: ["text", "image"] }
// multimodal: { input_modalities: ["text", "image", "audio"] }

if (enriched.input_modalities?.includes("image")) {
  refined.capabilities = {
    ...(refined.capabilities ?? {}),
    imageInput: true,
  };
}
```

**Edge Cases**:

- Missing `input_modalities`: Don't set `capabilities.imageInput` (fail safe)
- Unknown modalities: Ignore (forward compatibility)
- Empty array: Don't set `capabilities.imageInput`

### Error Handling

Enrichment failures should never break model access:

```typescript
try {
  await this.enrichModelIfNeeded(modelId);
  // Apply enrichment in ModelsClient (Approach A) or trigger refresh (Approach B)
} catch (error) {
  // Log but continue with base information
  logger.warn(`Enrichment failed for ${modelId}:`, error);
}
return baseInfo;
```

**Failure Modes**:

1. Network timeout: Use cached data or fall back to base
2. Invalid response: Validate schema, fall back on error
3. Missing fields: Apply only available refinements
4. Disabled by config: Skip enrichment entirely

### Caching Strategy

Already implemented in RFC 008 Phase 5:

- In-memory `Map<string, EnrichedModelData>` with TTL
- Persistent storage via `globalState` for cross-session caching
- 5-minute TTL for freshness (configurable via `ENRICHMENT_CACHE_TTL_MS`)

**Cache Key**: Full model identifier (e.g., `openai:gpt-4o`)

**Persistence**: Cached on enrichment success, restored on activation

### Event-Based Refresh

For the event-based approach, the provider must notify VS Code after enrichment completes. Without this, VS Code will not re-query model information and the picker will remain stale.

### VS Code API Integration

The `LanguageModelChatProvider` interface also supports refresh notifications:

```typescript
interface LanguageModelChatProvider {
  onDidChangeLanguageModelChatInformation?: Event<void>;
}
```

Use this event for the event-based refresh approach: after enrichment completes, fire the event so VS Code re-queries `provideLanguageModelChatInformation()` and updates the picker.

**Implementation Location**: `apps/vscode-ai-gateway/src/provider.ts`

**Key Methods**:

- `provideLanguageModelChatInformation()`: Supplies model list (base or enriched)
- `enrichModelIfNeeded()`: Trigger enrichment (already exists)
- `ModelsClient.transformToVSCodeModels()`: Applies capability mapping when using inline enrichment

## Implementation Checklist

### Phase 1: Core Refinement Logic

- [ ] **Update `provideLanguageModelChatInformation()`** to support enrichment
  - File: `apps/vscode-ai-gateway/src/provider.ts`
  - Location: Line ~155
  - Change: Either apply inline enrichment or return base list and rely on event refresh

- [ ] **Inline enrichment path (Approach A)**
  - File: `apps/vscode-ai-gateway/src/models.ts`
  - Location: `ModelsClient.getModels()` / `transformToVSCodeModels()`
  - Logic: Apply enriched `context_length` (if different) and `input_modalities` → `capabilities.imageInput`

- [ ] **Event-based refresh path (Approach B)**
  - File: `apps/vscode-ai-gateway/src/provider.ts`
  - Location: Enrichment completion point (see `enrichModelIfNeeded()` around line 228)
  - Logic: Fire `onDidChangeLanguageModelChatInformation` after enrichment completes

### Phase 2: Configuration

- [ ] **Add `models.enrichmentEnabled` setting**
  - File: `apps/vscode-ai-gateway/package.json`
  - Section: `contributes.configuration.properties`
  - Default: `true`

- [ ] **Add accessor to `ConfigService`**
  - File: `apps/vscode-ai-gateway/src/config.ts`
  - Logic:
    ```typescript
    get modelsEnrichmentEnabled(): boolean {
      return this.config.get("models.enrichmentEnabled", true);
    }
    ```

### Phase 3: Error Handling & Edge Cases

- [ ] **Wrap enrichment in try-catch**
  - File: `apps/vscode-ai-gateway/src/provider.ts`
  - Location: `provideLanguageModelChatInformation()`
  - Behavior: Log warning, continue with base info

- [ ] **Validate enriched data schema**
  - File: `apps/vscode-ai-gateway/src/models.ts` (Approach A) or `apps/vscode-ai-gateway/src/provider.ts` (Approach B)
  - Method: `transformToVSCodeModels()` or event refresh mapping
  - Checks: Numeric limits > 0, array types, field existence

- [ ] **Handle missing/partial enrichment fields**
  - File: `apps/vscode-ai-gateway/src/models.ts` (Approach A) or `apps/vscode-ai-gateway/src/provider.ts` (Approach B)
  - Method: `transformToVSCodeModels()` or event refresh mapping
  - Strategy: Apply only available refinements, don't fail if fields missing

### Phase 4: Testing

- [ ] **Unit tests for enrichment-to-capability mapping**
  - File: `apps/vscode-ai-gateway/src/models.test.ts` (or new file)
  - Cases:
    - Apply context_length (only if different) to maxInputTokens
    - Apply image modality to `capabilities.imageInput` boolean
    - Handle missing fields gracefully
    - Ignore invalid values

- [ ] **Unit tests for token limit handling**
  - Cases:
    - Base uses `context_window` from `/v1/models`
    - Enrichment `context_length` overrides only when different
    - Invalid/negative values ignored

- [ ] **Integration tests for config toggle**
  - Cases:
    - enrichmentEnabled=true → refinement applied
    - enrichmentEnabled=false → base info returned
    - Config change → respects new value

- [ ] **Integration tests for error scenarios**
  - Cases:
    - Enrichment fetch fails → base info returned
    - Invalid enrichment data → base info returned
    - Timeout → falls back gracefully

### Phase 5: Documentation

- [ ] **Update RFC 008 to reference RFC 008a**
  - File: `docs/rfcs/008-high-fidelity-model-mapping.md`
  - Section: Phase 5 checklist (last item)
  - Note: Already updated with reference to RFC 008a

- [ ] **Add JSDoc to enrichment mapping**
  - `ModelsClient.transformToVSCodeModels()`: How enrichment overrides capabilities and token limits
  - Provider event refresh: when and why `onDidChangeLanguageModelChatInformation` fires

- [ ] **Update README with enrichment capabilities**
  - File: `apps/vscode-ai-gateway/README.md`
  - Section: Features
  - Content: Explain automatic capability refinement and config option

## Drawbacks

1. **Complexity**: Adds async logic to model information preparation
2. **API Dependency**: Reliant on enrichment endpoint availability
3. **Cache Invalidation**: 5-minute TTL may be stale for rapidly changing model specs
4. **Testing Surface**: More scenarios to test (enriched vs base, failures, partial data)

## Alternatives Considered

### Alternative 1: Manual Capability Declaration

Maintain static mapping of model → capabilities in extension code.

**Pros**: No API dependency, predictable  
**Cons**: Requires manual updates, doesn't scale across providers  
**Verdict**: Rejected—doesn't leverage Vercel AI Gateway's model knowledge

### Alternative 2: Per-Request Enrichment

Fetch enrichment on every chat request instead of at model list time.

**Pros**: Always fresh data  
**Cons**: Adds latency to every chat, wasteful for identical models  
**Verdict**: Rejected—poor UX, cache strategy is superior

### Alternative 3: Eager Preload All Models

Enrich all models at extension activation.

**Pros**: Model picker immediately accurate  
**Cons**: Slow activation, wasted API calls for unused models  
**Verdict**: Rejected—lazy enrichment is more efficient

## Open Questions

1. **Should we expose enriched capabilities beyond token limits and image support?**
   - e.g., `supports_implicit_caching` could inform user of prompt caching availability
   - Consider adding to VS Code's `capabilities` object if API supports it

2. **Should enrichment TTL be configurable?**
   - Current: 5 minutes hardcoded
   - Pros: Users can tune freshness vs API load
   - Cons: More config surface

3. **Should we batch-enrich multiple models?**
   - If enrichment endpoint supports batch requests (currently unknown)
   - Would reduce API calls when model picker opens with many models

4. **How to handle deprecated/removed models?**
   - Enrichment may return 404 for old model IDs
   - Should we cache negative results to avoid repeated 404s?

## Implementation Priority

**P0 (Must Have)**:

- Core refinement logic (maxInputTokens, `capabilities.imageInput`)
- Error handling and fallbacks
- Config toggle

**P1 (Should Have)**:

- Token calculation helper
- Comprehensive unit tests
- Integration tests for failure modes

**P2 (Nice to Have)**:

- Batch enrichment (if API supports)
- Configurable TTL
- Extended capability exposure

## Success Metrics

- Model picker displays with enriched token limits within 2 seconds of opening
- Image-capable models show attachment UI without hardcoding
- Enrichment failures don't impact model availability
- 95%+ cache hit rate for commonly used models across sessions

## References

- [RFC 008: High-Fidelity Model Mapping](./008-high-fidelity-model-mapping.md)
- [VS Code Language Model API](https://code.visualstudio.com/api/references/vscode-api#LanguageModelChatInformation)
- [Vercel AI Gateway Models Endpoint](https://vercel.ai-gateway.com/docs/endpoints/models)
- Implementation: [apps/vscode-ai-gateway/src/models/enrichment.ts](../../apps/vscode-ai-gateway/src/models/enrichment.ts)
- Provider: [apps/vscode-ai-gateway/src/provider.ts](../../apps/vscode-ai-gateway/src/provider.ts)
