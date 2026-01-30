# RFC 008: High-Fidelity Model Mapping

**Status:** ✅ Implemented  
**Author:** Vercel AI Team  
**Created:** 2026-01-27  
**Updated:** 2026-01-28

## Summary

Improve the fidelity of model metadata fetching from Vercel AI Gateway and mapping to VS Code's LanguageModel API, ensuring accurate representation of model capabilities, context windows, and identity.

## Motivation

The original implementation had several fidelity gaps. This RFC proposed fixes that have now been implemented:

1. **✅ `family` parsing** — Implemented via `parseModelIdentity()` ([models/identity.ts](../../apps/vscode-ai-gateway/src/models/identity.ts))
2. **✅ `version` parsing** — Implemented in same function with date/version regex
3. **✅ `maxInputTokens`** — Now uses full `context_window` ([models.ts#L122](../../apps/vscode-ai-gateway/src/models.ts#L122))
4. **✅ Model type filtering** — Filters to `chat`, `language`, or unspecified types ([models.ts#L106-L107](../../apps/vscode-ai-gateway/src/models.ts#L106-L107))
5. **✅ Capability detection** — Includes `reasoning`, `web-search` tags ([models.ts#L117-L134](../../apps/vscode-ai-gateway/src/models.ts#L117-L134))

~~These issues reduce the effectiveness of VS Code's model selection UI and can cause suboptimal behavior during conversations.~~

## Detailed Design

### Phase 1: Model Identity Parsing

Parse `family` and `version` from the model ID string:

```typescript
// Current: "openai:gpt-4o-2024-11-20"
// Desired: family = "gpt-4o", version = "2024-11-20"

interface ParsedModelIdentity {
  provider: string; // "openai"
  family: string; // "gpt-4o"
  version: string; // "2024-11-20"
  fullId: string; // "openai:gpt-4o-2024-11-20"
}

function parseModelIdentity(modelId: string): ParsedModelIdentity {
  const [provider, modelName] = modelId.split(":");

  // Extract version suffix (date pattern or version number)
  const versionMatch = modelName.match(
    /[-_](\d{4}-\d{2}-\d{2}|\d+\.\d+(?:\.\d+)?)$/,
  );
  const version = versionMatch?.[1] ?? "latest";
  const family = versionMatch
    ? modelName.slice(0, -versionMatch[0].length)
    : modelName;

  return { provider, family, version, fullId: modelId };
}
```

**Examples:**

| Model ID                               | Provider  | Family            | Version    |
| -------------------------------------- | --------- | ----------------- | ---------- |
| `openai:gpt-4o-2024-11-20`             | openai    | gpt-4o            | 2024-11-20 |
| `anthropic:claude-3.5-sonnet-20241022` | anthropic | claude-3.5-sonnet | 20241022   |
| `google:gemini-2.0-flash`              | google    | gemini-2.0-flash  | latest     |
| `mistral:mistral-large-2411`           | mistral   | mistral-large     | 2411       |

### Phase 2: Accurate Token Limits (✅ Implemented)

Now uses the true `context_window` value for `maxInputTokens` ([models.ts#L122](../../apps/vscode-ai-gateway/src/models.ts#L122)):

```typescript
// Current implementation:
maxInputTokens: model.context_window,
maxOutputTokens: model.max_tokens,
```

Preflight validation in the request path warns when approaching limits ([provider.ts#L264-L283](../../apps/vscode-ai-gateway/src/provider.ts#L264-L283)):

```typescript
const TOKEN_WARNING_THRESHOLD = 0.9; // 90% of limit

function validateTokenBudget(
  estimatedTokens: number,
  maxInputTokens: number,
  logger: Logger,
): void {
  const usage = estimatedTokens / maxInputTokens;
  if (usage > TOKEN_WARNING_THRESHOLD) {
    logger.warn(
      `Token usage at ${(usage * 100).toFixed(1)}% of limit. ` +
        `Consider summarizing context.`,
    );
  }
}
```

### Phase 3: Model Type Filtering (✅ Implemented)

Models are filtered by `type` field to only include language models in chat ([models.ts#L106-L107](../../apps/vscode-ai-gateway/src/models.ts#L106-L107)):

```typescript
interface VercelModel {
  id: string;
  name: string;
  type: "language" | "embedding" | "image";
  // ...
}

function filterChatModels(models: VercelModel[]): VercelModel[] {
  return models.filter((model) => model.type === "language");
}
```

### Phase 4: Enhanced Capability Detection (✅ Implemented)

Capability detection now includes all supported tags ([models.ts#L117-L134](../../apps/vscode-ai-gateway/src/models.ts#L117-L134)):

```typescript
interface ModelCapabilities {
  supportsVision: boolean;
  supportsToolUse: boolean;
  supportsReasoning: boolean; // NEW
  supportsWebSearch: boolean; // NEW
  supportsStreaming: boolean; // NEW (assume true for language models)
}

function detectCapabilities(model: VercelModel): ModelCapabilities {
  const tags = new Set(model.tags ?? []);

  return {
    supportsVision: tags.has("vision"),
    supportsToolUse: tags.has("tool-use"),
    supportsReasoning: tags.has("reasoning"),
    supportsWebSearch: tags.has("web-search"),
    supportsStreaming: true, // All Vercel Gateway language models support streaming
  };
}
```

### Phase 5: Optional Per-Model Enrichment (✅ Implemented)

Per-model enrichment is implemented via `ModelEnricher` class ([models/enrichment.ts](../../apps/vscode-ai-gateway/src/models/enrichment.ts)) with:

- In-memory + persistent caching via `globalState`
- Configurable TTL (5 minutes default)
- Event-based refresh via `onDidChangeLanguageModelChatInformation`

For selected models (e.g., user's preferred model), fetch additional metadata:

```typescript
// GET /v1/models/{creator}/{model}/endpoints
// Actual API response structure (discovered 2026-01-28):
interface EnrichmentResponse {
  data: {
    id: string; // e.g., "openai/gpt-4o"
    name: string; // e.g., "GPT-4o"
    description: string;
    architecture: {
      modality: string;
      input_modalities: string[]; // e.g., ["text", "image"]
      output_modalities: string[]; // e.g., ["text"]
    };
    endpoints: ModelEndpoint[]; // Multiple providers per model
  };
}

interface ModelEndpoint {
  name: string; // Provider name
  context_length: number; // e.g., 128000
  max_completion_tokens: number; // e.g., 16384
  supported_parameters: string[]; // e.g., ["max_tokens", "temperature", "tools"]
  supports_implicit_caching: boolean;
  // Additional fields (not used in MVP):
  // pricing: { prompt, completion, ... }
  // latency_last_1h: { p50, p95 }
  // throughput_last_1h: { p50, p95 }
}

// Simplified implementation: use first endpoint, in-memory cache only
async function enrichModelMetadata(
  modelId: string,
  baseMetadata: VercelModel,
): Promise<EnrichedModel> {
  // Only enrich on-demand to avoid rate limits
  const response = await fetchModelEndpoints(modelId);
  const endpoint = response.data.endpoints[0]; // Use first provider

  return {
    ...baseMetadata,
    contextLength: endpoint?.context_length ?? baseMetadata.context_window,
    maxCompletionTokens:
      endpoint?.max_completion_tokens ?? baseMetadata.max_output_tokens,
    supportedParameters: endpoint?.supported_parameters ?? [],
    supportsImplicitCaching: endpoint?.supports_implicit_caching ?? false,
    // Bonus: refine capabilities from architecture
    inputModalities: response.data.architecture?.input_modalities ?? [],
  };
}
```

**Discovery Note (2026-01-28):** The enrichment endpoint exists and is functional on Vercel AI Gateway. Testing confirms:

- Endpoint: `GET /v1/models/{creator}/{model}/endpoints` returns nested `data.endpoints[]` array
- Example: `openai/gpt-4o/endpoints` returns `context_length: 128000`, `max_completion_tokens: 16384`, `supported_parameters`, `supports_implicit_caching`
- Multi-provider: Each model can have multiple endpoints (azure, openai, etc.) — use first endpoint for MVP
- Behavior: Returns 404 for invalid/retired models (e.g., `openai/gpt-4`), so graceful fallback to base model data is required
- Recommendation: Implement lazy/on-demand loading with in-memory caching (no persistence needed)

**Simplifying Assumptions for MVP:**

1. Use first endpoint only (multi-provider aggregation can be added later)
2. ~~In-memory cache with same TTL as models cache (5 min) — no persistence~~ **Updated:** Persistent caching via `globalState` for faster startup
3. Extract core fields: `context_length`, `max_completion_tokens`, `supported_parameters`, `supports_implicit_caching`, `input_modalities`
4. On-demand enrichment for selected model only, not all models

**Integration Strategy (2026-01-28):**

1. **Initialization:** Create singleton `ModelEnricher` in extension activation, call `initializePersistence(globalState)` to restore cache from previous session
2. **Lazy enrichment:** Call `enrichModel()` in `provideLanguageModelChatResponse()` before making API call — enriches on first use of each model
3. **Capability refinement:** Use `input_modalities` to update `imageInput` capability; use `context_length` for more accurate token limits
4. **Graceful fallback:** If enrichment fails, use base model metadata without blocking the request

## Implementation Checklist

- [x] Add `parseModelIdentity()` function with tests _(Implemented in `models/identity.ts`)_
- [x] Update `provideLanguageModels()` to use parsed `family` and `version` _(Implemented in `models.ts`)_
- [x] Change `maxInputTokens` to use true `context_window` _(Implemented)_
- [x] Add preflight token budget validation with warning _(Implemented in token counting)_
- [x] Filter models by `type === 'language'` _(Implemented in `models.ts`)_
- [x] Expand capability detection to include `reasoning`, `web-search` _(Implemented in `models.ts`)_
- [x] (Phase 5) Add enrichment module with caching _(Implemented in `models/enrichment.ts`)_
- [x] (Phase 5) Add `input_modalities` extraction _(Implemented)_
- [x] (Phase 5) Add persistent caching via `globalState` _(Implemented)_
- [x] (Phase 5) Wire enricher into extension activation and provider flow _(Implemented in `provider.ts`)_

**Note:** See [RFC 008a](./008a-enrichment-capability-refinement.md) for using enrichment data to refine capabilities and token limits.

## Drawbacks

1. **Breaking change for selectors** - Users who rely on current `family` values (org names) will need to update their selectors
2. **Token limit change** - Removing the 85% buffer may cause more context overflow errors initially
3. **Additional API calls** - Per-model enrichment adds latency and potential rate limit concerns

## Alternatives

### Alternative A: Server-side mapping

Have the Vercel AI Gateway return pre-parsed `family` and `version` fields. This would be more reliable but requires backend changes.

### Alternative B: Static model registry

Maintain a static mapping of known models to their families/versions. This is more predictable but requires updates when new models are released.

### Alternative C: Keep 85% buffer, add user setting

Instead of removing the token buffer, make it configurable via `vercelAiGateway.tokenBufferPercent`.

## Unresolved Questions

1. Should we cache parsed model identities, or parse on every registration?
2. How should we handle models that don't follow the `provider:name-version` pattern?
3. Should the per-model enrichment be opt-in via settings?

## Implementation Plan

**Phase 1: Model Identity** (1-2 hours)

- Implement `parseModelIdentity()` with comprehensive tests
- Update model registration to use parsed values

**Phase 2: Token Limits** (1 hour)

- Remove 85% multiplier
- Add preflight validation with logging

**Phase 3: Type Filtering** (30 minutes)

- Add `type` filter to model fetching
- Verify no embedding/image models in chat list

**Phase 4: Capabilities** (1 hour)

- Expand capability detection
- Update VS Code registration to include new capabilities

**Phase 5: Enrichment** (optional, 2 hours)

- Implement on-demand endpoint fetching
- Add caching to prevent repeated calls
