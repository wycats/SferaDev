---
title: VS Code Proposed Language Model Provider APIs
stage: 0
feature: Unknown
exo:
    tool: exo rfc create
    protocol: 1
---

# RFC 00021: VS Code Proposed Language Model Provider APIs

**Status:** Draft  
**Author:** GitHub Copilot  
**Created:** 2026-01-30  
**Updated:** 2026-01-30

## Summary

Track and document VS Code's proposed Language Model Provider APIs that are relevant to the AI Gateway extension. These APIs are in various stages of development and cannot be used in published Marketplace extensions, but understanding them helps us prepare for future capabilities and identify workarounds for current limitations.

## Motivation

VS Code's Language Model API is actively evolving. Several proposed APIs would significantly enhance our extension's capabilities:

1. **Better provider integration** (`chatProvider`) - Core API for registering LM providers
2. **Reasoning/thinking support** (`languageModelThinkingPart`) - Stream thinking tokens from models like o1, Claude
3. **Capability exposure** (`languageModelCapabilities`) - Expose model capabilities to consumers
4. **System message support** (`languageModelSystem`) - Native system role support
5. **Audience-aware content** (`languageModelToolResultAudience`) - Control what content goes to model vs user
6. **Tool progress** (`toolProgress`) - Report progress during tool invocation

Understanding these APIs helps us:

- Plan for future integration when APIs stabilize
- Identify current workarounds where proposed APIs would solve problems
- Track VS Code's direction for the Language Model API
- Prepare migration paths when APIs are finalized

## Proposed APIs Inventory

### 1. `chatProvider` (Core Provider API)

**File:** [`vscode.proposed.chatProvider.d.ts`](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.chatProvider.d.ts)  
**Version:** 4  
**Last Updated:** ~January 2026 (Fix #275134)

#### What It Does

Defines the core interfaces for registering a Language Model Chat Provider:

```typescript
interface LanguageModelChatProvider<T extends LanguageModelChatInformation> {
  provideLanguageModelChatInformation(
    options: PrepareLanguageModelChatModelOptions,
    token: CancellationToken,
  ): ProviderResult<T[]>;

  provideLanguageModelChatResponse(
    model: T,
    messages: readonly LanguageModelChatRequestMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    progress: Progress<LanguageModelResponsePart2>,
    token: CancellationToken,
  ): Thenable<void>;
}

interface LanguageModelChatInformation {
  requiresAuthorization?: true | { label: string };
  multiplier?: string; // e.g., "2x" for quota
  isDefault?: boolean | { [K in ChatLocation]?: boolean }; // NOT BEING FINALIZED
  isUserSelectable?: boolean; // NOT BEING FINALIZED
  category?: { label: string; order: number }; // WONT BE FINALIZED
  statusIcon?: ThemeIcon;
}

interface LanguageModelChatCapabilities {
  editTools?: string[]; // 'find-replace', 'multi-find-replace', 'apply-patch', 'code-rewrite'
}

type LanguageModelResponsePart2 =
  | LanguageModelResponsePart
  | LanguageModelDataPart
  | LanguageModelThinkingPart;
```

#### Relevance to Our Extension

**Critical** - This is the foundation of our extension. We already implement a provider, but:

- `requiresAuthorization` could replace our custom auth flow
- `multiplier` could expose model cost information to users
- `editTools` hints could improve agentic editing behavior
- `statusIcon` could show model status in the picker

#### Current Workaround

We use the stable subset of this API. Features marked "NOT BEING FINALIZED" or "WONT BE FINALIZED" should not be relied upon.

---

### 2. `languageModelThinkingPart` (Reasoning Tokens)

**File:** [`vscode.proposed.languageModelThinkingPart.d.ts`](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.languageModelThinkingPart.d.ts)  
**Version:** 1  
**Last Updated:** ~October 2025 (finalize languageModelDataPart and tools api #265537)

#### What It Does

Adds support for streaming thinking/reasoning tokens:

```typescript
class LanguageModelThinkingPart {
  value: string | string[];
  id?: string; // Identifier for the thinking sequence
  metadata?: { readonly [key: string]: any };

  constructor(
    value: string | string[],
    id?: string,
    metadata?: { readonly [key: string]: any },
  );
}

interface LanguageModelChatResponse {
  stream: AsyncIterable<
    | LanguageModelTextPart
    | LanguageModelThinkingPart
    | LanguageModelToolCallPart
    | unknown
  >;
}

class LanguageModelChatMessage2 {
  content: Array<
    | LanguageModelTextPart
    | LanguageModelToolResultPart
    | LanguageModelToolCallPart
    | LanguageModelDataPart
    | LanguageModelThinkingPart
  >;
}
```

#### Relevance to Our Extension

**High** - OpenResponses supports reasoning models (o1, Claude with extended thinking). Currently:

- We receive `reasoning` content from OpenResponses but cannot expose it properly via stable APIs
- VS Code consumers cannot see the model's reasoning process in collapsible blocks
- Token counts for reasoning tokens are tracked but not surfaced in the UI

#### Current Workaround

Reasoning content is currently:

1. Logged for debugging (via our logging infrastructure)
2. Included in token counts via `output_tokens_details.reasoning_tokens`
3. Emitted as `LanguageModelTextPart` (visible but not collapsible)

#### Future Integration

When finalized, we should:

1. Map OpenResponses `response.reasoning.delta` to `LanguageModelThinkingPart`
2. Include thinking parts in the response stream
3. Preserve thinking context for conversation continuity

---

### 3. `languageModelCapabilities` (Capability Exposure)

**File:** [`vscode.proposed.languageModelCapabilities.d.ts`](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.languageModelCapabilities.d.ts)  
**Version:** N/A (no version marker)  
**Last Updated:** ~September 2025 (api: allow byok model providers to hint at good edit tools #268506)

#### What It Does

Exposes model capabilities on `LanguageModelChat`:

```typescript
interface LanguageModelChat {
  readonly capabilities: {
    readonly supportsToolCalling: boolean;
    readonly supportsImageToText: boolean;
    readonly editToolsHint?: readonly string[];
  };
}
```

#### Relevance to Our Extension

**Medium** - We already provide capability information via model tags, but this API would let consumers query capabilities at runtime:

- `supportsToolCalling` - We infer from model tags and enrichment data
- `supportsImageToText` - We infer from `input_modalities` enrichment data
- `editToolsHint` - Could be derived from model family (e.g., OpenAI models → 'apply-patch')

#### Current Workaround

Capabilities are declared in model transformation via tags from the Vercel AI Gateway `/models` endpoint. This is the provider-side declaration; the proposed API is the consumer-side query interface.

---

### 4. `languageModelSystem` (System Messages)

**File:** [`vscode.proposed.languageModelSystem.d.ts`](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.languageModelSystem.d.ts)  
**Version:** N/A  
**Last Updated:** ~January 2024  
**Tracking Issue:** [#206265](https://github.com/microsoft/vscode/issues/206265)

#### What It Does

Adds a System role to the message role enum:

```typescript
enum LanguageModelChatMessageRole {
  User = 1,
  Assistant = 2,
  System = 3, // NEW
}
```

#### Relevance to Our Extension

**High** - OpenResponses has full system message support via `developer` role items. Currently:

- VS Code only has User (1) and Assistant (2) roles
- System instructions must be passed via other mechanisms
- Our message translator maps unknown roles to `developer`

#### Design Considerations (from VS Code comments)

The API comments note uncertainty about this approach:

> "don't have this dedicated type but as property, e.g anthropic doesn't have a system-role"
> "we could have `LanguageModelChatMessage.options.system` which would be more limiting but also more natural"

This suggests the API may change significantly before finalization.

#### Current Workaround

System prompts from configuration are mapped to OpenResponses `developer` items. See [message-translation-mapping.md](../research/message-translation-mapping.md) for details.

---

### 5. `languageModelToolResultAudience` (Content Audience)

**File:** [`vscode.proposed.languageModelToolResultAudience.d.ts`](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.languageModelToolResultAudience.d.ts)  
**Version:** N/A  
**Last Updated:** ~April 2025 (api: generalize ToolResultAudience->LanguageModelTextPart #259273)

#### What It Does

Adds audience targeting for message parts:

```typescript
enum LanguageModelPartAudience {
  Assistant = 0, // Show to the language model
  User = 1, // Show to the user
  Extension = 2, // Retain for internal bookkeeping
}

class LanguageModelTextPart2 extends LanguageModelTextPart {
  audience: LanguageModelPartAudience[] | undefined;
  constructor(value: string, audience?: LanguageModelPartAudience[]);
}

class LanguageModelDataPart2 extends LanguageModelDataPart {
  audience: LanguageModelPartAudience[] | undefined;
  constructor(
    data: Uint8Array,
    mimeType: string,
    audience?: LanguageModelPartAudience[],
  );
}
```

#### Relevance to Our Extension

**Medium** - This could enable:

- Sending verbose tool results to the model while showing summaries to users
- Keeping extension-internal metadata out of the model context
- Separating debugging information from user-visible content
- Potentially routing reasoning content to user only (visible) or model only (context)

#### Current Workaround

All content is currently sent to both model and user. No audience separation is possible.

---

### 6. `toolProgress` (Tool Invocation Progress)

**File:** [`vscode.proposed.toolProgress.d.ts`](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.toolProgress.d.ts)  
**Version:** N/A  
**Last Updated:** ~April 2025 (update with api feedback)

#### What It Does

Adds progress reporting during tool invocation:

```typescript
interface ToolProgressStep {
  message?: string | MarkdownString;
  increment?: number; // Summed until 100 (100%)
}

interface LanguageModelTool<T> {
  invoke(
    options: LanguageModelToolInvocationOptions<T>,
    token: CancellationToken,
    progress: Progress<ToolProgressStep>, // NEW parameter
  ): ProviderResult<LanguageModelToolResult>;
}
```

#### Relevance to Our Extension

**Low** - This API is for tool implementers (extensions that provide tools), not for LM providers like us. However, understanding it helps us know what tool invocations might look like from the consumer side.

---

## Marketplace Publishing Constraints

**⚠️ Critical:** Proposed APIs cannot be used in extensions published to the VS Code Marketplace.

From VS Code documentation:

> "Proposed APIs are unstable and subject to breaking changes. They are only available in VS Code Insiders and require the extension to be run with `--enable-proposed-api`."

### Implications for Our Extension

1. **No proposed API usage in production** - Our published extension cannot use any of these APIs
2. **Feature detection required** - If we want to use these APIs in development/Insiders, we must detect availability at runtime
3. **Graceful degradation** - Code paths using proposed APIs must have fallbacks

### Development/Testing Strategy

For local development and testing with Insiders:

```typescript
// Feature detection pattern
function hasThinkingPartSupport(): boolean {
  return typeof vscode.LanguageModelThinkingPart !== "undefined";
}

// Usage with fallback
if (hasThinkingPartSupport()) {
  progress.report(new vscode.LanguageModelThinkingPart(thinkingContent));
} else {
  // Fallback: emit as text or suppress
  progress.report(new vscode.LanguageModelTextPart(thinkingContent));
}
```

To enable proposed APIs in development:

1. Add to `package.json`: `"enabledApiProposals": ["chatProvider", "languageModelThinkingPart", ...]`
2. Run VS Code Insiders with: `code-insiders --enable-proposed-api <your-extension-id>`

---

## Tracking & Monitoring

### How to Track API Changes

1. **Watch the vscode-dts folder:** https://github.com/microsoft/vscode/tree/main/src/vscode-dts
2. **Monitor VS Code release notes:** https://code.visualstudio.com/updates
3. **Track specific issues:**
   - System messages: https://github.com/microsoft/vscode/issues/206265
   - Chat Provider API: Search for `chatProvider` in VS Code issues

### API Maturity Indicators

| API                               | Version | Last Activity | Stability Assessment                                        |
| --------------------------------- | ------- | ------------- | ----------------------------------------------------------- |
| `chatProvider`                    | v4      | Jan 2026      | Active development, some parts marked "NOT BEING FINALIZED" |
| `languageModelThinkingPart`       | v1      | Oct 2025      | Recently finalized adjacent APIs, likely stabilizing        |
| `languageModelCapabilities`       | N/A     | Sep 2025      | Stable shape, waiting for finalization                      |
| `languageModelSystem`             | N/A     | Jan 2024      | Stalled, design uncertainty noted                           |
| `languageModelToolResultAudience` | N/A     | Apr 2025      | Generalized recently, may change                            |
| `toolProgress`                    | N/A     | Apr 2025      | Simple API, likely stable                                   |

---

## Recommendations

### Short-term (Current)

1. **Do not use proposed APIs** in the published extension
2. **Document workarounds** for each capability gap
3. **Monitor finalization** of high-priority APIs (thinking, capabilities)

### Medium-term (When APIs Stabilize)

1. **Prepare migration paths** for thinking token support
2. **Design capability exposure** aligned with `languageModelCapabilities`
3. **Add feature detection** infrastructure for optional capabilities

### Long-term (When APIs are Finalized)

1. **Adopt finalized APIs** as they become available in stable VS Code
2. **Remove workarounds** as native support is added
3. **Update minimum VS Code version** to require APIs we depend on

---

## Implementation Notes from Codebase Analysis

Based on investigation of the current codebase:

### Reasoning/Thinking Content

**Current location:** [stream-adapter.ts](../../packages/vscode-ai-gateway/src/provider/stream-adapter.ts)

Reasoning events from OpenResponses are currently handled but emit `LanguageModelTextPart`:

```typescript
// Current behavior - emits TEXT, not THINKING
case 'response.reasoning.delta':
case 'response.reasoning_summary.delta':
  return {
    parts: [new LanguageModelTextPart(delta)],
    done: false,
  };
```

**When proposed API available:** Change to emit `LanguageModelThinkingPart` instead.

### System Messages

**Current location:** [message translation logic]

System prompts from config are mapped to OpenResponses `developer` role. Per OpenResponses IMPLEMENTATION_CONSTRAINTS.md, both `system` and `developer` work but `developer` is recommended.

### Capability Exposure

**Current location:** Model transformation in [models.ts](../../packages/vscode-ai-gateway/src/models.ts)

Capabilities are inferred from model tags (tool calling, image support) and enrichment data. This aligns well with the proposed `languageModelCapabilities` API shape.

---

## Related RFCs

- [RFC 016: OpenResponses Architecture](./016-openresponses-architecture.md) - Provider refactoring that would benefit from these APIs
- [RFC 014: Enrichment-Based Capability Refinement](./014-enrichment-capability-refinement.md) - Capability detection that aligns with `languageModelCapabilities`

## References

- [VS Code Proposed APIs Documentation](https://code.visualstudio.com/api/advanced-topics/using-proposed-api)
- [VS Code vscode-dts Folder](https://github.com/microsoft/vscode/tree/main/src/vscode-dts)
- [Language Model API Overview](https://code.visualstudio.com/api/extension-guides/language-model)
