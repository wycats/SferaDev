---
title: VS Code DataPart Persistence & Conversation State
feature: Unknown
exo:
  tool: exo rfc create
  protocol: 1
---

# RFC 00063: VS Code DataPart Persistence & Conversation State

**Stage**: 0 (Idea)
**Created**: 2026-02-09
**Author**: Agent (session research)

## Summary

VS Code's `LanguageModelDataPart` has an **undocumented persistence mechanism** that allows extensions to round-trip opaque binary data through the chat message history. This mechanism is how Microsoft's first-party Copilot Chat extension implements conversation chaining, thinking block preservation, prompt caching, and context management — all features that appear impossible from the public API surface.

We have empirically confirmed this mechanism works for third-party chat providers. This RFC proposes using it to simplify our extension and add thinking block support.

## Background

### The DataPart Persistence Mechanism

VS Code only persists `LanguageModelDataPart` instances whose `mimeType` matches one of four hardcoded strings. This is **not documented** anywhere in the public API. The strings are defined in Microsoft's `endpointTypes.ts`:

```typescript
export namespace CustomDataPartMimeTypes {
  export const CacheControl = "cache_control";
  export const StatefulMarker = "stateful_marker";
  export const ThinkingData = "thinking";
  export const ContextManagement = "context_management";
}
```

DataParts with any other MIME type are silently dropped (empirically confirmed — RFC-compliant MIME types like `application/vnd.foo+json` do not persist).

| MIME string          | Purpose                                               | Who uses it                |
| -------------------- | ----------------------------------------------------- | -------------------------- |
| `cache_control`      | Anthropic prompt caching breakpoints                  | Copilot Chat, VS Code core |
| `stateful_marker`    | Session/response ID for conversation chaining         | Copilot Chat, GCMP, us     |
| `thinking`           | Persisted thinking/reasoning blocks (CoT, signatures) | Copilot Chat, GCMP         |
| `context_management` | Anthropic context editing responses (what was pruned) | Copilot Chat               |

### The `stateful_marker` Encoding Format

DataPart bytes for `stateful_marker` use a specific format:

```
modelId\JSON
```

`modelId` is a string before a literal backslash; `JSON` is the payload after it. VS Code's Copilot infrastructure may rewrite the `modelId` prefix. The JSON payload passes through untouched. Our implementation namespaces the payload with `extension: "sferadev.vscode-ai-gateway"` (matching GCMP's approach with their own extension ID).

### The `thinking` Data Format

Thinking data does **not** use the `modelId\JSON` format. Microsoft's `ThinkingDataContainer` wraps thinking data in an opaque prompt-tsx element with this shape:

```typescript
interface ThinkingData {
  id: string;
  text: string | string[];
  metadata?: { [key: string]: any };
  tokens?: number;
  encrypted?: string;
}
```

The ThinkingDataContainer produces an opaque content part with structure `{ type: 'thinking', thinking: ThinkingData }`. This is parsed back via `rawPartAsThinkingData()` which type-checks the `type` field.

### `LanguageModelThinkingPart` — Runtime Availability Without Proposed API

A critical finding: `LanguageModelThinkingPart` is available on the `vscode` runtime namespace **unconditionally** — it is not gated by any `checkProposedApiEnabled` call (confirmed in VS Code core `extHost.api.impl.ts` line 2069). However, it is **not** present in the stable `@types/vscode` type declarations (confirmed: zero matches in `@types/vscode@1.108.1`).

This means:

- Any extension can `new vscode.LanguageModelThinkingPart(...)` at runtime on current stable VS Code
- TypeScript will error unless we provide our own type declaration
- No `enabledApiProposals` entry is needed — and adding one would **block marketplace publishing** (the marketplace rejects extensions with `enabledApiProposals`)

GCMP declares `"chatProvider"` in `enabledApiProposals`, but they distribute as a sideloaded `.vsix` via GitHub releases, not via the marketplace. We cannot follow this pattern.

The `chatProvider` proposed API's `LanguageModelResponsePart2` type formally includes `ThinkingPart` in the progress callback union, but the runtime accepts it regardless because `progress.report()` dispatches via `instanceof` checks, not type unions. The stable `LanguageModelResponsePart` type (without `ThinkingPart`) is the compile-time type; at runtime, VS Code core handles all four part types unconditionally.

**Note on `chatProvider` stabilization**: The core `LanguageModelChatProvider` interface and `registerLanguageModelChatProvider` are already in stable `@types/vscode` (1.108.1). The `chatProvider` proposal (version 4) only adds supplementary features: `ProvideLanguageModelChatResponseOptions.requestInitiator`, extended `LanguageModelChatInformation` fields (`requiresAuthorization`, `multiplier`, etc.), `editTools` capabilities, and the wider `LanguageModelResponsePart2` union. Several proposal fields are annotated "NOT BEING FINALIZED" or "WONT BE FINALIZED", suggesting the base has stabilized but picker/selection features are still iterating.

### Our Approach: Local Type Augmentation with CI Verification

Since `LanguageModelThinkingPart` exists at runtime but not in stable types, we define it ourselves:

1. **Module augmentation** (`src/types/vscode-thinking.d.ts`): Extends the `'vscode'` module declaration to add the `LanguageModelThinkingPart` class. This eliminates all `as any` casts and provides proper type-checking for the constructor, properties, and progress callback usage.

2. **CI shape verification**: A script or test that fetches the canonical `vscode.proposed.languageModelThinkingPart.d.ts` from `microsoft/vscode` main and verifies our local declaration is compatible — detects upstream drift before it causes runtime failures.

### Reference Implementations

Our `.reference/` directory contains both source trees:

- **Microsoft Copilot Chat** (`.reference/vscode-copilot-chat/`): The canonical implementation. Uses `ThinkingDataContainer` for persistence, `LanguageModelThinkingPart` for streaming, and handles thinking reconstruction from message history when building API requests.
- **GCMP** (`.reference/GCMP/`): Third-party Chinese-language extension. Adapted Microsoft's patterns. Distributes as sideloaded `.vsix` (not marketplace).

## Completed Work

### Phase 1: Stateful Marker Persistence ✅

Production-quality `stateful_marker` round-trip:

- `CustomDataPartMimeTypes` namespace in `stateful-marker.ts` with all 4 MIME types
- Encode/decode/find utilities for the `modelId\JSON` format
- Emit `DataPart("stateful_marker")` at `response.completed` in `stream-adapter.ts`
- Read marker and set `previous_response_id` in `openresponses-chat.ts`
- Exclusion filters in `digest.ts`, `counter.ts`, `message-translation.ts`
- 25 tests covering encode/decode/find/round-trip scenarios

### Phase 2: Token Counting Simplification ✅

Replaced ~3,000 lines of delta estimation infrastructure with direct tokenization:

- Swapped `js-tiktoken` → `ai-tokenizer` (pure JS, Claude + OpenAI encodings)
- Rewrote `counter.ts` as a `TokenCounter` class with model-family → encoding dispatch
- Simplified `provideTokenCount` to a one-liner delegating to `TokenCounter`
- Simplified `estimateTotalInputTokens` to direct sum of messages + tools + system prompt
- Deleted 12 files: `conversation-state.ts`, `sequence-tracker.ts`, `hybrid-estimator.ts`, `estimator.ts`, `validation-logger.ts`, `cache.ts` (and all tests)
- Removed `tokensEstimationMode`/`tokensCharsPerToken` configuration settings
- Bundle: 9.6 MB (o200k_base 7.8 MB + claude 2.3 MB)

## Proposed Work

### Phase 3: Thinking Block Persistence

Enable thinking/reasoning content (from Claude extended thinking, o1, etc.) to stream with proper UI rendering and persist across turns.

#### Architecture

The thinking block system has three layers:

1. **Type Declaration**: A local `src/types/vscode-thinking.d.ts` module augmentation that declares `LanguageModelThinkingPart` and widens `LanguageModelResponsePart`. This lets us use the class type-safely even though it's not in stable `@types/vscode`. CI verifies our declaration matches the upstream proposed API.

2. **Stream Emission**: During streaming, `handleReasoningDelta` in `stream-adapter.ts` emits `LanguageModelThinkingPart` (for UI rendering — VS Code shows these as collapsible thinking blocks) and accumulates thinking content. At the end of a thinking sequence, also emit `DataPart('thinking')` containing the full thinking data (text, id, signature metadata) for persistence.

3. **Reconstruction**: On the next turn, scan assistant messages for `DataPart('thinking')` and translate back to appropriate API-level thinking blocks (Anthropic `thinking`/`redacted_thinking` with signatures, OpenAI reasoning tokens, etc.).

#### Key Design Decisions

- **ThinkingPart + DataPart dual emission**: We emit both. `ThinkingPart` gives us proper VS Code thinking UI (collapsible blocks, distinct rendering). `DataPart('thinking')` gives us reliable round-trip persistence — VS Code automatically persists it in message history and makes it available on subsequent turns.
- **No `enabledApiProposals`**: The `LanguageModelThinkingPart` class is ungated at runtime. We must NOT add `enabledApiProposals` to `package.json` as it would block marketplace publishing.
- **Local type augmentation**: We declare `LanguageModelThinkingPart` in our own `.d.ts` file rather than using `as any` casts. CI verifies the declaration stays compatible with upstream.
- **Buffered emission**: Like GCMP, we buffer thinking deltas (threshold ~20 chars) before emitting a `ThinkingPart`, and track a `currentThinkingId` to maintain thinking chain continuity. An empty `ThinkingPart` signals end-of-chain.
- **Broadened exclusion filters**: Extend `isStatefulMarkerMime()` to also cover the `thinking` MIME type, so thinking DataParts are excluded from token counting, digest hashing, and message translation (same treatment as `stateful_marker`).

### Phase 4: Prompt Caching Integration

Pass through `cache_control` DataParts to OpenResponses as Anthropic `cache_control: { type: 'ephemeral' }` breakpoints. Depends on OpenResponses server support (see `docs/bugs/ai-gateway-openresponses-anthropic-caching.md`).

### Phase 5: CI Monitoring for Upstream Changes

The MIME types and `LanguageModelThinkingPart` shape are undocumented internal APIs. Establish automated drift detection:

- **MIME type conformance tests**: Assert the 4 known MIME types and their exact string values
- **ThinkingPart shape verification**: CI script that fetches `vscode.proposed.languageModelThinkingPart.d.ts` from `microsoft/vscode` main and diffs/type-checks against our local declaration
- **Upstream monitoring**: Scheduled GitHub Action (weekly) that detects changes to `CustomDataPartMimeTypes` or the ThinkingPart proposed API, opening an issue if drift is detected

### Phase 6: Context Management (Future)

Anthropic's context editing (`clear_tool_uses`, `clear_thinking`) for automatic context window management in long agent sessions. Lower priority.

## Risks

1. **Undocumented API surface**: The MIME type allowlist is not in any public documentation. Microsoft could change it. Mitigation: (a) they won't break their own Copilot Chat extension, (b) GCMP has been shipping this for months, (c) Phase 5 establishes CI drift detection.

2. **`LanguageModelThinkingPart` shape drift**: The class is present at runtime but not in stable types. If Microsoft changes the constructor signature or removes it, our code breaks silently. Mitigation: local type declaration with CI shape verification (Phase 5), plus the DataPart persistence layer remains stable regardless.

3. **`modelId` rewriting**: VS Code may rewrite the modelId prefix in the `stateful_marker` encoding. We handle this by reading from the JSON payload after the backslash, not from the prefix.

## References

- `.reference/vscode-copilot-chat/src/platform/endpoint/common/endpointTypes.ts` — MIME constants
- `.reference/vscode-copilot-chat/src/platform/endpoint/common/statefulMarkerContainer.tsx` — Marker implementation
- `.reference/vscode-copilot-chat/src/platform/endpoint/common/thinkingDataContainer.tsx` — Thinking persistence (ThinkingDataContainer, rawPartAsThinkingData)
- `.reference/vscode-copilot-chat/src/platform/thinking/common/thinking.ts` — ThinkingData/ThinkingDelta interfaces
- `.reference/vscode-copilot-chat/src/platform/endpoint/vscode-node/extChatEndpoint.ts` — Streaming: ThinkingPart on stream, DataPart→ThinkingPart conversion for history messages
- `.reference/vscode-copilot-chat/src/extension/conversation/vscode-node/languageModelAccessPrompt.tsx` — ThinkingPart → ThinkingDataContainer conversion (history → API request)
- `.reference/vscode-copilot-chat/src/extension/conversation/vscode-node/languageModelAccess.ts` — Provider-side streaming with ThinkingPart progress emission
- `.reference/vscode/src/vs/workbench/api/common/extHost.api.impl.ts` — Ungated ThinkingPart on namespace (line 2069)
- `.reference/vscode/src/vs/workbench/api/common/extHostLanguageModels.ts` — instanceof-based part dispatch (DataPart and ThinkingPart are separate wire types)
- `.reference/vscode/src/vscode-dts/vscode.proposed.languageModelThinkingPart.d.ts` — Proposed type definition (our augmentation target)
- `.reference/vscode/src/vscode-dts/vscode.proposed.chatProvider.d.ts` — chatProvider proposal (version 4, base already stable)
- `.reference/GCMP/src/handlers/types.ts` — GCMP's MIME constants
- `.reference/GCMP/src/handlers/streamReporter.ts` — GCMP's unified streaming (ThinkingPart + buffering + end-of-chain)
- `.reference/GCMP/package.json` — Declares `chatProvider` in enabledApiProposals (sideloaded, not marketplace)
- `docs/bugs/ai-gateway-openresponses-anthropic-caching.md` — Cache control gap analysis
