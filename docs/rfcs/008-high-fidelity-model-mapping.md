# RFC 008: High-Fidelity Model Mapping

**Status:** Draft  
**Author:** Vercel AI Team  
**Created:** 2026-01-27  
**Updated:** 2026-01-27

## Summary

Improve the fidelity of model metadata fetching from Vercel AI Gateway and mapping to VS Code's LanguageModel API, ensuring accurate representation of model capabilities, context windows, and identity.

## Motivation

The current implementation has several fidelity gaps that affect user experience and VS Code's ability to manage models correctly:

1. **Incorrect `family` property** - Uses `creator` (org name) instead of model family, breaking VS Code selectors like `@family:gpt-4o`
2. **Hardcoded `version`** - Always `"1.0"` instead of actual model version
3. **Understated `maxInputTokens`** - Uses 85% of context window, triggering premature context compaction
4. **Missing model type filter** - Embedding and image models appear in chat model list
5. **Incomplete capability detection** - Only `vision` and `tool-use` tags used; `reasoning`, `web-search` ignored

These issues reduce the effectiveness of VS Code's model selection UI and can cause suboptimal behavior during conversations.

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

### Phase 2: Accurate Token Limits

Use the true `context_window` value for `maxInputTokens`:

```typescript
// Before (conservative but inaccurate)
maxInputTokens: Math.floor(model.context_window * 0.85);

// After (accurate, handle margins in preflight)
maxInputTokens: model.context_window;
```

Add preflight validation in the request path to warn when approaching limits:

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

### Phase 3: Model Type Filtering

Filter models by `type` field to only include language models in chat:

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

### Phase 4: Enhanced Capability Detection

Expand capability detection beyond `vision` and `tool-use`:

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

### Phase 5: Optional Per-Model Enrichment

For selected models (e.g., user's preferred model), fetch additional metadata:

```typescript
// GET /v1/models/{creator}/{model}/endpoints
interface ModelEndpointDetails {
  context_length: number;
  max_completion_tokens: number;
  supported_parameters: string[];
  supports_implicit_caching: boolean;
}

async function enrichModelMetadata(
  modelId: string,
  baseMetadata: VercelModel,
): Promise<EnrichedModel> {
  // Only enrich on-demand to avoid rate limits
  const details = await fetchModelEndpoints(modelId);

  return {
    ...baseMetadata,
    contextLength: details.context_length ?? baseMetadata.context_window,
    maxCompletionTokens:
      details.max_completion_tokens ?? baseMetadata.max_output_tokens,
    supportedParameters: details.supported_parameters ?? [],
    supportsImplicitCaching: details.supports_implicit_caching ?? false,
  };
}
```

## Implementation Checklist

- [ ] Add `parseModelIdentity()` function with tests
- [ ] Update `provideLanguageModels()` to use parsed `family` and `version`
- [ ] Change `maxInputTokens` to use true `context_window`
- [ ] Add preflight token budget validation with warning
- [ ] Filter models by `type === 'language'`
- [ ] Expand capability detection to include `reasoning`, `web-search`
- [ ] (Optional) Add on-demand endpoint enrichment for selected models

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
