---
title: Model Family String Mapping
stage: 0
feature: Unknown
exo:
  tool: exo rfc create
  protocol: 1
---

# RFC 00051: Model Family String Mapping

**Status**: Stage 0 (Idea)  
**Created**: 2026-02-05  
**Author**: Agent  
**Related**: RFC 009 (Token Counting), RFC 008 (High-Fidelity Model Mapping, withdrawn)

## Summary

The VS Code Language Model API requires every `LanguageModelChatProvider` to expose a `family` string for each model. This string is **opaque** — VS Code places no constraints on it, and there is no formal registry. However, extensions that consume models (like Copilot Chat) use `selectChatModels({ family: '...' })` to find models by family, making the choice of family string a **de facto interoperability contract**.

This RFC documents:

1. What `family` means in the VS Code API
2. How GitHub Copilot currently defines its family strings
3. How vscode-ai-gateway currently derives family strings
4. Whether the Vercel AI Gateway (OpenResponses) has any concept of model families
5. The gap between these systems and what we should do about it

## Background: The VS Code `family` Property

From `vscode.d.ts` (stable API):

```typescript
interface LanguageModelChat {
  /**
   * Opaque family-name of the language model. Values might be `gpt-3.5-turbo`,
   * `gpt4`, `phi2`, or `llama` but they are defined by extensions contributing
   * languages and subject to change.
   */
  readonly family: string;
}
```

Key facts:

- **Opaque**: VS Code treats it as an arbitrary string
- **Defined by extensions**: Each provider extension chooses values
- **Subject to change**: No stability guarantee
- **Used for selection**: Consumers call `lm.selectChatModels({ family: '...' })` to filter

### How Copilot Uses Family Strings

The VS Code Language Model API guide ([source](https://code.visualstudio.com/api/extension-guides/language-model)) lists the following Copilot model families:

| Copilot Family      | Underlying Model  |
| ------------------- | ----------------- |
| `gpt-4o`            | GPT-4o            |
| `gpt-4o-mini`       | GPT-4o Mini       |
| `o1`                | O1                |
| `o1-mini`           | O1 Mini           |
| `claude-3.5-sonnet` | Claude 3.5 Sonnet |

These are the strings that any extension using `selectChatModels()` will look for. An extension consuming our models via `selectChatModels({ family: 'gpt-4o' })` will only find our model if we emit exactly `gpt-4o` as the family.

> **Source reference**: The official list lives in the [VS Code Language Model guide](https://code.visualstudio.com/api/extension-guides/language-model). The JSDoc lives in [`vscode.d.ts`](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.d.ts) on the `LanguageModelChat.family` property. The proposed provider-side API is in [`vscode.proposed.chatProvider.d.ts`](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.chatProvider.d.ts) — the `LanguageModelChatInformation.family` property mirrors the same contract.

## Current Implementation: `parseModelIdentity`

The extension derives `family` by parsing the gateway's model ID string.

**Source**: `packages/vscode-ai-gateway/src/models/identity.ts`

```typescript
// Regex: matches date (YYYY-MM-DD), compact date (YYYYMMDD), or semver at end of string
const VERSION_PATTERN = /[-_](\d{4}-\d{2}-\d{2}|\d{4,8}|\d+\.\d+(?:\.\d+)?)$/;

function parseModelIdentity(modelId: string): ParsedModelIdentity {
  // 1. Split on ":" or "/" to extract provider (gateway uses slash format)
  // 2. Apply VERSION_PATTERN to split remaining into family + version
}
```

> **Note**: The function's JSDoc examples use colon format (`openai:gpt-4o-2024-11-20`), but the gateway uses slash format (`openai/gpt-4o`). Both are handled identically.

### Current Mapping Table (Derived)

Given model IDs from the Vercel AI Gateway (`/v1/models`), here is how `parseModelIdentity` maps them:

| Gateway Model ID                       | → Provider  | → Family            | → Version  | Notes                                          |
| -------------------------------------- | ----------- | ------------------- | ---------- | ---------------------------------------------- |
| `openai/gpt-4o`                        | `openai`    | `gpt-4o`            | `latest`   | ✅ Matches Copilot                             |
| `openai/gpt-4o-mini`                   | `openai`    | `gpt-4o-mini`       | `latest`   | ✅ Matches Copilot                             |
| `openai/o1`                            | `openai`    | `o1`                | `latest`   | ✅ Matches Copilot                             |
| `anthropic/claude-3.5-sonnet`          | `anthropic` | `claude-3.5-sonnet` | `latest`   | ✅ Matches Copilot                             |
| `anthropic/claude-3.5-sonnet-20240620` | `anthropic` | `claude-3.5-sonnet` | `20240620` | ✅ Matches Copilot                             |
| `anthropic/claude-sonnet-4`            | `anthropic` | `claude-sonnet-4`   | `latest`   | No Copilot equivalent                          |
| `anthropic/claude-sonnet-4.5`          | `anthropic` | `claude-sonnet`     | `4.5`      | ⚠️ **Bug**: regex eats model number as version |
| `google/gemini-2.0-flash`              | `google`    | `gemini-2.0-flash`  | `latest`   | No Copilot equivalent                          |
| `meta/llama-3.3-70b`                   | `meta`      | `llama-3.3-70b`     | `latest`   | No Copilot equivalent                          |
| `meta/llama-4-maverick`                | `meta`      | `llama-4-maverick`  | `latest`   | No Copilot equivalent                          |

> **Note**: The gateway catalog does not currently include `o1-mini`.

### Where Family Is Used Downstream

1. **Tokenizer selection** (`tokens/counter.ts:resolveEncodingName`):
   - `gpt-4o`, `o1`, `o3` → `o200k_base`
   - Everything else → `cl100k_base` (Claude, Gemini, Llama, etc.)
   - Uses `family.includes("gpt-4o")` / `family === "o1"` pattern matching

2. **VS Code model metadata** (`models.ts:transformModels`):
   - `family` is set on `LanguageModelChatInformation` directly from the parse result
   - `version` is set similarly
   - `vendor` is hardcoded to `"vercel"` (VENDOR_ID)

3. **Enrichment endpoint** (`models/enrichment.ts:extractCreatorAndModel`):
   - Uses `provider` + model name to construct the gateway enrichment URL:
     `{gateway}/v1/models/{creator}/{model}/endpoints`

4. **Token counter caching** (`tokens/counter.ts`):
   - Cache keys are `{modelFamily}:{textHash}`
   - Different families get separate cache buckets

## The Vercel AI Gateway: No Family Concept

**Finding**: The Vercel AI Gateway (OpenResponses) has **no concept of model family**. The gateway exposes:

- A **`model` string** in request/response bodies (e.g., `"anthropic/claude-sonnet-4.5"`)
- A **`/v1/models` catalog** returning objects with `id`, `name`, `description`, `context_window`, `max_tokens`, `type`, `tags`, `pricing`
- **No `family` field** in any schema

Model IDs use slash format: `provider/model` (e.g., `anthropic/claude-sonnet-4.5`). The extension derives family entirely client-side — the gateway cannot help with this mapping.

### Enrichment Endpoint

The enrichment endpoint (`{gateway}/v1/models/{creator}/{model}/endpoints`) returns:

- `context_length`, `max_completion_tokens`, `supported_parameters`, `supports_implicit_caching`, `input_modalities`
- An `architecture` object with `modality`, `input_modalities`, `output_modalities`, `tokenizer`, `instruct_type`
- **No family field** — it uses the same raw model identifier

### Tokenizer Metadata: Present in Schema, Null in Practice

The gateway's enrichment endpoint includes an `architecture.tokenizer` field, but **it is always `null`**. Some models don't return an `architecture` object at all.

Example (live response for `openai/gpt-4o`):

```json
{
  "data": {
    "architecture": {
      "tokenizer": null,
      "instruct_type": null,
      "modality": "text+image+file→text",
      "input_modalities": ["text", "image", "file"],
      "output_modalities": ["text"]
    }
  }
}
```

The extension's `EnrichmentResponse` type omits `tokenizer` from its `architecture` typing accordingly.

**For comparison**: OpenRouter's `/api/v1/models` endpoint _does_ populate `architecture.tokenizer` with labels like `\"GPT\"`, `\"Claude\"`, `\"Mistral\"`, `\"DeepSeek\"`, etc. The gateway does not pass this through.

The `/v1/models` listing has no `architecture` field at all — only the enrichment endpoint returns it, and even there `tokenizer` is always `null`. Any tokenizer selection must be done client-side or the gateway must be updated to populate this field.

### What the Gateway Already Has

The gateway codebase has relevant infrastructure that isn't yet exposed in the API:

- **`architecture.tokenizer` (schema + upstream data, not wired up)**: The enrichment endpoint schema defines `tokenizer: z.string()`. OpenRouter (the gateway's upstream model data source) populates it with labels like `"GPT"`, `"Claude"`, `"Mistral"`. The gateway's enrichment route has a TODO: `// TODO: Source tokenizer from Model interface or provider metadata`. The data is available — it's just not passed through.

- **Primary/secondary slugs (a proto-family)**: The gateway groups models using `primaryModel` / `secondaryModels` fields. For example, `claude-3.5-sonnet-20240620` is a secondary slug under `claude-3.5-sonnet`. This is the closest thing to a family concept in the gateway, but it's not exposed in the API.

- **`type` enum**: `language | embedding | image`. Could be used to filter non-language models from the VS Code model list.

- **`reasoning` tag**: Indicates extended thinking support. Maps to `supported_parameters: ['reasoning', 'include_reasoning']` in the enrichment response.

- **Internal ↔ external ID format**: The gateway uses colon format internally (`anthropic:claude-sonnet-4`) and slash format externally (`anthropic/claude-sonnet-4`), with explicit conversion helpers. Our parser supporting both formats is correct.

## The Problem: Three Naming Systems

We have three different naming systems that must interoperate:

| System                     | Example                                        | Who Controls It               |
| -------------------------- | ---------------------------------------------- | ----------------------------- |
| **Copilot family strings** | `gpt-4o`, `claude-3.5-sonnet`                  | Microsoft (de facto standard) |
| **Gateway model IDs**      | `openai/gpt-4o`, `anthropic/claude-3.5-sonnet` | Vercel AI Gateway             |
| **Our derived families**   | `gpt-4o`, `claude-3.5-sonnet`                  | `parseModelIdentity` regex    |

### Copilot Compatibility

All Copilot-equivalent models currently **match correctly**:

| Copilot Family      | Gateway ID                    | Our Derived Family  | Match? |
| ------------------- | ----------------------------- | ------------------- | ------ |
| `gpt-4o`            | `openai/gpt-4o`               | `gpt-4o`            | ✅     |
| `gpt-4o-mini`       | `openai/gpt-4o-mini`          | `gpt-4o-mini`       | ✅     |
| `o1`                | `openai/o1`                   | `o1`                | ✅     |
| `o1-mini`           | _(not in gateway catalog)_    | —                   | —      |
| `claude-3.5-sonnet` | `anthropic/claude-3.5-sonnet` | `claude-3.5-sonnet` | ✅     |

The gateway uses `claude-3.5-sonnet` (with dot), which matches Copilot's convention exactly. No override table is needed for current Copilot-equivalent models.

### Parsing Bug: Semver-Like Model Numbers

The `VERSION_PATTERN` regex (`/[-_](\d{4}-\d{2}-\d{2}|\d{4,8}|\d+\.\d+(?:\.\d+)?)$/`) matches semver-like suffixes as version strings. This causes a **parsing bug** for models with decimal numbers in their name:

| Gateway ID                    | Expected Family     | Actual Family      | Actual Version | Bug?                           |
| ----------------------------- | ------------------- | ------------------ | -------------- | ------------------------------ |
| `anthropic/claude-sonnet-4`   | `claude-sonnet-4`   | `claude-sonnet-4`  | `latest`       | ✅ OK (single digit, no match) |
| `anthropic/claude-sonnet-4.5` | `claude-sonnet-4.5` | `claude-sonnet`    | `4.5`          | ⚠️ **Bug**                     |
| `google/gemini-2.0-flash`     | `gemini-2.0-flash`  | `gemini-2.0-flash` | `latest`       | ✅ OK (not at end of string)   |

The regex matches `-4.5` at the end of `claude-sonnet-4.5` as a semver version (`\d+\.\d+`), stripping it from the family. This means `claude-sonnet-4.5` and `claude-sonnet-4` would be treated as the **same family** (`claude-sonnet`) with different versions — which is incorrect. They are distinct models.

Note that `gemini-2.0-flash` is unaffected because `-flash` follows the `2.0`, so the regex doesn't match at the end of the string.

### Models Without Copilot Precedent

For models Copilot doesn't offer (Gemini, Llama, Mistral, etc.), there is no "right answer" — no consumer extension is looking for those families yet. We derive what seems natural from the gateway ID:

| Gateway ID                | Our Family         | Notes                 |
| ------------------------- | ------------------ | --------------------- |
| `google/gemini-2.0-flash` | `gemini-2.0-flash` | No Copilot equivalent |
| `meta/llama-3.3-70b`      | `llama-3.3-70b`    | No Copilot equivalent |
| `meta/llama-4-maverick`   | `llama-4-maverick` | No Copilot equivalent |

## Design Constraints

### DC1: No Bundled Mapping Data

**Constraint**: If the mapping or mapping rules can change, the data **must be hosted remotely** — not included with the extension — so it can be updated without shipping an extension update.

This applies to:

- **Family override tables** (if needed for future naming mismatches)
- **Tokenizer mappings** (e.g., family → tiktoken encoding name)
- **Any model metadata** that may change as providers add/rename models

Rationale: Model catalogs change frequently. An extension update cycle is too slow to keep up. The enrichment endpoint pattern (`ModelEnricher`) already demonstrates the right approach — fetch metadata from a remote source at runtime.

Acceptable approaches:

- **Gateway-hosted**: The Vercel AI Gateway returns the data as part of `/v1/models` or enrichment responses (preferred — the extension already talks to the gateway)
- **Sidecar endpoint**: A separate metadata service the extension queries

Unacceptable approaches:

- Hardcoded `Map<string, string>` in extension source
- JSON files bundled in the extension package
- Constants files that require code changes to update

**Exception**: Fallback defaults (e.g., "if no tokenizer info available, assume `cl100k_base`") may be hardcoded as conservative safety nets, but must not be the primary source of truth.

## Open Questions

### Q1: Should we maintain a manual mapping table?

The regex-based approach (`parseModelIdentity`) works for all current Copilot-equivalent models, but has a known parsing bug with `claude-sonnet-4.5` (see "Parsing Bug" section). Options:

**A) Gateway-hosted family field**: The gateway adds a `family` field to `/v1/models` or the enrichment response. The extension consumes it directly. _(Preferred per DC1)_

**B) Normalized family names**: Apply normalization rules (e.g., dots ↔ hyphens) post-parse to increase compatibility. _(Acceptable — rules are code, not data, so they don't violate DC1)_

**C) Accept divergence**: Accept that our families won't match Copilot's exactly, document the differences.

~~**D) Bundled override table**: Maintain a `Map<string, string>` in extension source.~~ _(Violates DC1 — mapping data must not be bundled)_

### Q2: How do we handle model catalog changes?

The Vercel AI Gateway catalog (`/v1/models`) changes as models are added. Our current approach:

- **Regex-based**: Automatically handles new models (just splits on version suffix)
- **No registry required**: New models get a family by parsing
- **But**: No guarantee the derived family matches what any consumer expects

If we add a manual override table, it becomes a **maintenance burden** — every new model needs a mapping entry, or falls through to regex.

### Q3: Is Copilot family compatibility a concern?

All Copilot-equivalent models currently produce matching family strings. But this compatibility is **fragile** — it depends on the gateway's naming conventions continuing to align with Copilot's. If the gateway changes a model ID (e.g., renaming `claude-3.5-sonnet` to `claude-35-sonnet`), the family would diverge silently.

The more immediate concern is the **`claude-sonnet-4.5` parsing bug** (see "Parsing Bug" section above), where the regex incorrectly strips the model number as a version suffix.

### Q4: Should the gateway provide family and tokenizer metadata?

Two small gateway changes would solve most of this RFC's problems. Both build on infrastructure that already exists in the gateway codebase:

1. **Pass through `architecture.tokenizer`**: The enrichment endpoint schema already defines `tokenizer: z.string()`. OpenRouter (the gateway's upstream data source) already populates it. The gateway route already has a TODO to wire it up. This is a pass-through, not a new feature.

2. **Expose `primaryModel` as `family`**: The gateway already groups models using `primaryModel` / `secondaryModels` (e.g., `claude-3.5-sonnet-20240620` is secondary under `claude-3.5-sonnet`). Exposing `primaryModel` in the enrichment response or `/v1/models` would give the extension a server-authoritative family string, eliminating client-side regex parsing.

Both changes would:

- Satisfy DC1 (remote-hosted, no bundled data)
- Remove the need for client-side `parseModelIdentity` regex
- Enable data-driven tokenizer selection instead of hardcoded `resolveEncodingName`
- Automatically handle new models without extension changes

### Q5: What about the tokenizer mapping?

The tokenizer (`resolveEncodingName`) uses family strings to select tokenizer encoding. This is currently hardcoded:

```typescript
if (family.includes("gpt-4o") || family === "o1" || family === "o3") {
  return "o200k_base";
}
return "cl100k_base"; // everything else
```

This works today but will break silently if:

- A new OpenAI model doesn't contain "gpt-4o" in its family
- A non-OpenAI model starts using a BPE vocabulary (not cl100k_base)

**Gateway status**: The enrichment endpoint has an `architecture.tokenizer` field in its schema, but it is **always `null`**. OpenRouter's API _does_ populate this field — the gateway does not pass it through.

If the gateway were to populate `architecture.tokenizer`, it would enable a data-driven approach:

1. Fetch `architecture.tokenizer` from the enrichment endpoint (already called by `ModelEnricher`)
2. Map the label to a tiktoken encoding: `"GPT"` → `o200k_base`, everything else → `cl100k_base` (or skip tiktoken entirely for non-OpenAI models)
3. Per **DC1**, this mapping must come from the gateway, not be hardcoded

This would replace the fragile `family.includes("gpt-4o")` pattern with a robust, data-driven approach that automatically handles new models. But it requires a gateway change first.

## Recommendation

**Short-term** (extension-side):

- **Fix the `claude-sonnet-4.5` parsing bug** (see "Parsing Bug" section). Either exclude single-digit semver from the pattern, or add a minimum-length heuristic.
- **Keep regex derivation** (`parseModelIdentity`) as the family-string fallback.
- **Keep hardcoded `resolveEncodingName`** as a conservative fallback for tokenizer selection.

**Medium-term** (gateway-side — two small changes):

- **Pass through `architecture.tokenizer`**: The schema exists, the upstream data exists, there's a TODO in the code. Once wired up, the extension can read it from the enrichment response (already fetched by `ModelEnricher`) and use it for data-driven tokenizer selection.
- **Expose `primaryModel` as `family`**: The gateway already groups models this way internally. Exposing it in the enrichment response gives the extension a server-authoritative family string, eliminating the regex and the parsing bug in one step.

**Long-term**: The gateway should own the canonical family string and tokenizer metadata, making the extension a thin consumer. Track what families Copilot adds over time and ensure compatibility.

## References

- VS Code stable API: [`LanguageModelChat.family`](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.d.ts)
- VS Code proposed API: [`LanguageModelChatInformation.family`](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.chatProvider.d.ts)
- VS Code LM guide: [Language Model API](https://code.visualstudio.com/api/extension-guides/language-model)
- Identity parser: `packages/vscode-ai-gateway/src/models/identity.ts`
- Tokenizer mapping: `packages/vscode-ai-gateway/src/tokens/counter.ts:resolveEncodingName` (L265–L286)
- Model transformation: `packages/vscode-ai-gateway/src/models.ts:transformModels` (L388–L440)
- Enrichment: `packages/vscode-ai-gateway/src/models/enrichment.ts`
- Conservative limits: `packages/vscode-ai-gateway/src/constants.ts` (128k input, 16k output)
