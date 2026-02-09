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

We have empirically confirmed this mechanism works for third-party chat providers. This RFC documents the findings and proposes overhauling our extension to use it.

## Discovery

### Source

The mechanism was discovered by reverse-engineering GCMP (vicanent.gcmp), a Chinese-language VS Code extension that provides third-party model access. GCMP's source code explicitly cites:

> 参考: Microsoft vscode-copilot-chat src/platform/endpoint/common/statefulMarkerContainer.tsx

The original Microsoft implementation lives in the `vscode-copilot-chat` extension. Our `.reference/` directory contains both:

- **Microsoft's implementation**: `.reference/vscode-copilot-chat/src/platform/endpoint/common/`
  - `endpointTypes.ts` — MIME type constants
  - `statefulMarkerContainer.tsx` — Stateful marker encode/decode/scan
  - `thinkingDataContainer.tsx` — Thinking data persistence
- **GCMP's adaptation**: `.reference/GCMP/src/handlers/`
  - `types.ts` — Copied MIME type constants
  - `statefulMarker.ts` — Adapted encode/decode/scan
  - `streamReporter.ts` — Unified streaming with thinking + marker emission

### The Hardcoded MIME Type Allowlist

VS Code only persists `LanguageModelDataPart` instances whose `mimeType` matches one of four specific strings. This is **not documented** anywhere in the public API. The strings are defined in Microsoft's `endpointTypes.ts`:

```typescript
// .reference/vscode-copilot-chat/src/platform/endpoint/common/endpointTypes.ts
export namespace CustomDataPartMimeTypes {
  export const CacheControl = "cache_control";
  export const StatefulMarker = "stateful_marker";
  export const ThinkingData = "thinking";
  export const ContextManagement = "context_management";
}
```

**Empirical proof**: We tested by emitting a DataPart with MIME type `"application/vnd.vscode-ai-gateway.stateful-marker+json"` (RFC-compliant MIME). It was **silently dropped** — the diagnostic showed assistant messages only contained `DataPart(cache_control)`. When we switched to `"stateful_marker"`, the DataPart appeared in the next turn's assistant message and round-tripped successfully.

| MIME string          | Purpose                                               | Who uses it                  |
| -------------------- | ----------------------------------------------------- | ---------------------------- |
| `cache_control`      | Anthropic prompt caching breakpoints                  | Copilot Chat, VS Code core   |
| `stateful_marker`    | Session/response ID for conversation chaining         | Copilot Chat, GCMP, us (PoC) |
| `thinking`           | Persisted thinking/reasoning blocks (CoT, signatures) | Copilot Chat, GCMP           |
| `context_management` | Anthropic context editing responses (what was pruned) | Copilot Chat                 |

### The Encoding Format

DataPart bytes use a specific format for `stateful_marker`:

```
modelId\JSON
```

Where `modelId` is a string before a literal backslash, and `JSON` is the payload after it. VS Code's Copilot infrastructure **parses this format and may rewrite the modelId** (GCMP's comment: "copilot 内部始终会自动処理 modelId, 这里无论传递什么 modelId 都会被重置" — "Copilot internally always auto-processes modelId; whatever you pass will be reset"). The JSON payload after the backslash passes through untouched.

Microsoft's encode/decode:

```typescript
// .reference/vscode-copilot-chat/src/platform/endpoint/common/statefulMarkerContainer.tsx
export function encodeStatefulMarker(
  modelId: string,
  marker: string,
): Uint8Array {
  return new TextEncoder().encode(modelId + "\\" + marker);
}

export function decodeStatefulMarker(
  data: Uint8Array,
): StatefulMarkerWithModel {
  const decoded = new TextDecoder().decode(data);
  const [modelId, marker] = decoded.split("\\");
  return { modelId, marker };
}
```

### How GCMP Uses It

GCMP embeds an `extension` field in the JSON payload to namespace their data:

```typescript
// .reference/GCMP/src/handlers/statefulMarker.ts
const StatefulMarkerExtension = "vicanent.gcmp";

export interface StatefulMarkerContainer {
  extension: StatefulMarkerExtension;
  provider: string;
  modelId: string;
  sdkMode: "openai" | "openai-responses" | "anthropic" | "gemini";
  sessionId: string;
  responseId: string;
  expireAt?: number;
}
```

They scan backwards through assistant messages, filter by `extension === 'vicanent.gcmp'`, and extract `responseId` to set `previous_response_id` on the next API call.

### Our PoC Validation

We implemented and validated a working PoC (current branch, `feat/token-status-bar`):

1. **Emit**: In `stream-adapter.ts`, at `response.completed`, push a `LanguageModelDataPart` with MIME `"stateful_marker"` containing our response ID.
2. **Read**: In `openresponses-chat.ts`, before building the request, scan backwards through assistant messages for our marker and set `previous_response_id`.
3. **Result**: JSONL diagnostic confirmed the full round-trip:
   - Message N: emit `responseId: "gen_01KH0NXM57H1CC5YVNQEJT9X54"`
   - Message N+1: found marker → set `previous_response_id: "gen_01KH0NXM57H1CC5YVNQEJT9X54"` → emit new `responseId: "gen_01KH0NY0A8KG2DS10SV82Z0G4B"`

## What Can Be Removed

### The Problem We Over-Solved

Without `previous_response_id`, we had no way to tell the server "this is a continuation of conversation X." We invented an elaborate client-side system to:

1. **Identify conversations** — hash messages into digests, build prefix trees, detect when a new request extends a known conversation
2. **Track ground-truth token counts** — store the API-reported `input_tokens` keyed by conversation state, so we could delta-estimate on the next turn
3. **Compensate for estimation error** — rolling correction factors, sequence tracking, validation logging

With `stateful_marker` giving us reliable `previous_response_id`, the server handles conversation continuity. Much of our client-side conversation identity and delta estimation machinery becomes unnecessary.

### Files Removable or Simplifiable

| File                                        | Lines | Purpose                                                                                                     | Verdict                                                                             |
| ------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/tokens/conversation-state.ts`          | 948   | Digest-based conversation identity: prefix matching, state persistence via Memento, summarization detection | **Remove entirely**. `stateful_marker` provides conversation identity directly.     |
| `src/tokens/conversation-state.test.ts`     | 586   | Tests for the above                                                                                         | **Remove entirely**                                                                 |
| `src/tokens/hybrid-estimator.ts`            | 631   | Orchestrates delta estimation via ConversationStateTracker — "known + tiktoken(new)" strategy               | **Simplify drastically**. Replace with GCMP-style direct tiktoken per message.      |
| `src/tokens/hybrid-estimator.test.ts`       | 433   | Tests for the above                                                                                         | **Rewrite** to match simplified estimator                                           |
| `src/tokens/sequence-tracker.ts`            | 148   | Tracks bursts of `provideTokenCount` calls to accumulate per-turn totals                                    | **Remove entirely**. Not needed with simple per-message counting.                   |
| `src/tokens/sequence-tracker.test.ts`       | 271   | Tests for the above                                                                                         | **Remove entirely**                                                                 |
| `src/tokens/sequence-tracker-proof.test.ts` | 175   | Proof tests for the above                                                                                   | **Remove entirely**                                                                 |
| `src/tokens/cache.ts`                       | 196   | Caches actual token counts per message digest, persisted via Memento                                        | **Remove or simplify**. Replace with a plain LRU keyed by text content (like GCMP). |
| `src/tokens/cache.test.ts`                  | 298   | Tests for the above                                                                                         | **Remove or rewrite**                                                               |
| `src/tokens/estimator.ts`                   | 100   | Character-based fallback estimator with configurable chars-per-token modes                                  | **Remove entirely**. Tiktoken is the only estimator we need.                        |
| `src/tokens/estimator.test.ts`              | 153   | Tests for the above                                                                                         | **Remove entirely**                                                                 |
| `src/tokens/validation-logger.ts`           | 101   | Forensic JSONL logging of estimation vs. actual deltas                                                      | **Remove entirely**. Diagnostic infrastructure for the delta system.                |
| `src/tokens/lru-cache.ts`                   | 38    | Generic LRU cache                                                                                           | **Keep** (still useful for tiktoken text caching)                                   |

**Total removable**: ~3,089 lines of source + tests across 10 files.

### Other Simplifications

- **`src/utils/digest.ts`**: The `computeNormalizedDigest`, `computeRawDigest`, and `computeStableMessageHash` functions exist primarily for conversation identity matching. With `stateful_marker`, their only remaining use would be `forensic-capture.ts`. If forensic capture moves to use response IDs from markers, most digest functions can go too.
- **`src/provider.ts` (`provideTokenCount`)**: The 40-line forensic JSONL logging block (batch tracking, `.vscode-ai-gateway/token-count-calls.jsonl`) can be removed. The method itself becomes a one-liner like GCMP's.
- **`src/provider.ts` (`estimateTotalInputTokens`)**: The 80-line method with delta/exact/estimated source tracking becomes a simple `countAllMessages + overhead` call.
- **Configuration settings**: `tokensEstimationMode` (conservative/balanced/aggressive) and `tokensCharsPerToken` can be removed — no more character-based estimation.

## How We'd Still Get Accurate Token Counts

### GCMP's Approach (Simple and Correct)

GCMP's `provideTokenCount` is a **one-liner**:

```typescript
async provideTokenCount(model, text, _token) {
    return TokenCounter.getInstance().countTokens(model, text);
}
```

Their `TokenCounter` uses `@microsoft/tiktokenizer` with `o200k_base` encoding and a 5000-entry LRU text cache. For messages, it walks each content part:

- **Text parts**: `tokenizer.encode(text).length`
- **Tool calls**: `tokenizer.encode(JSON.stringify(toolCall)).length`
- **Image DataParts**: Tile-based estimation (`tiles * 170 + 85`, matching OpenAI/Anthropic specs)
- **Binary DataParts**: Small fixed estimate (`20 + ceil(byteLength / 16384)`, capped at 200)
- **Message overhead**: 3 tokens per message (separator/formatting)

No delta estimation. No conversation tracking. No correction factors. No persistence.

### Why This Works

VS Code calls `provideTokenCount` per message during prompt rendering to decide whether to truncate. The key insight is: **tiktoken with the right encoding is accurate enough for VS Code's truncation decisions**. GCMP has been shipping this for months without issues.

Our elaborate delta system was built on the premise that tiktoken alone wasn't accurate enough, and that we needed to "correct" estimates using ground-truth API response data. In practice, the error from tiktoken is small and consistent — well within the margins VS Code uses for truncation decisions.

### Accuracy Reality Check

Tiktoken alone is not *perfectly* accurate. `ai-tokenizer`'s Claude accuracy is 97-99%, meaning a 1-3% error on a 128K context window is 1,280-3,840 tokens off. For VS Code's truncation decisions (which have wide margins), this is fine. For cost display or precise context budget management, it might not be.

**The real argument for deleting the delta system isn't "tiktoken is accurate enough on its own."** It's that `previous_response_id` + server-side `usage` data provides a **better correction signal** than our current client-side digest-matching system:

- **Server knows the exact count**: The OpenResponses API response includes `usage.input_tokens` and `usage.output_tokens` — the ground truth from the model provider.
- **Simpler feedback loop**: Read `usage` from the response, cache it keyed by response ID, use it to calibrate the next estimate. No prefix-matching, no digest trees, no conversation state tracking.
- **Already available**: We get `usage` in every `response.completed` event. We just don't use it for calibration today.

If we find that 1-3% error matters for our use cases (status bar display, context budget warnings), the right fix is a lightweight calibration layer that adjusts `ai-tokenizer` counts using server-reported `usage` — not the 3,000-line delta estimation system we have today. This is something to evaluate during Phase 2 implementation.

### Our Simplified Token Counting (Post-Overhaul)

```typescript
// Replaces HybridTokenEstimator, ConversationStateTracker, CallSequenceTracker,
// TokenCache, TokenEstimator, TokenValidationLogger
import Tokenizer from "ai-tokenizer";
import * as o200k from "ai-tokenizer/encoding/o200k_base";
import * as claude from "ai-tokenizer/encoding/claude";

class TokenCounter {
  private tokenizers: Record<string, Tokenizer> = {
    openai: new Tokenizer(o200k),
    anthropic: new Tokenizer(claude),
  };

  countTokens(
    model: LanguageModelChatInformation,
    text: string | LanguageModelChatMessage,
  ): number {
    const tokenizer = this.getTokenizer(model.family);
    if (typeof text === "string") {
      return tokenizer.count(text);
    }
    // Walk content parts: text → encode, tool calls → JSON + encode,
    // images → tile estimate, binary → fixed estimate
    return this.countMessageParts(tokenizer, text) + 3; // +3 message overhead
  }

  private getTokenizer(family: string): Tokenizer {
    // Map model family to encoding. Claude models use the claude encoding;
    // everything else defaults to o200k_base.
    if (family.includes("claude") || family.includes("anthropic")) {
      return this.tokenizers.anthropic;
    }
    return this.tokenizers.openai;
  }
}
```

### Tokenizer Library Choice: `ai-tokenizer`

We currently use `js-tiktoken`. GCMP and Microsoft both use `@microsoft/tiktokenizer`. We recommend a third option: **[`ai-tokenizer`](https://github.com/coder/ai-tokenizer)** from Coder.

|                     | `ai-tokenizer`                                                 | `@microsoft/tiktokenizer`   | `js-tiktoken` (current) |
| ------------------- | -------------------------------------------------------------- | --------------------------- | ----------------------- |
| **Runtime**         | Pure JS (no WASM, no disk files)                               | Loads `.tiktoken` from disk | WASM blob (~4MB)        |
| **Speed**           | 5-7x faster than tiktoken                                      | Baseline                    | Baseline                |
| **Encodings**       | `o200k_base`, `cl100k_base`, `p50k_base`, **`claude`**         | `o200k_base` only           | Multiple                |
| **Claude accuracy** | 97-99% (validated, 1.10x multiplier)                           | N/A (wrong encoding)        | N/A (wrong encoding)    |
| **OpenAI accuracy** | 99-100%                                                        | 100%                        | 100%                    |
| **Model configs**   | Per-model overhead constants (`models.json`)                   | None                        | None                    |
| **Bundle**          | Tree-shakeable (2-8MB per encoding, import only what you need) | Bundled `.tiktoken` file    | WASM blob               |
| **License**         | MIT                                                            | MIT                         | MIT                     |

**Why `ai-tokenizer` over `@microsoft/tiktokenizer`**:

1. **Claude encoding** — We serve Claude models through OpenResponses. We currently tokenize Claude messages with `o200k_base` (an OpenAI vocabulary), which is incorrect. `ai-tokenizer` ships a reverse-engineered Claude BPE encoding with a calibrated 1.10x content multiplier, validated to 97-99% accuracy against real API responses.
2. **No WASM, no disk files** — Pure JS. Simpler extension bundling than `@microsoft/tiktokenizer` (which requires bundling a `.tiktoken` file and loading from disk at runtime).
3. **Per-model calibration** — The multiplier system addresses the exact accuracy gap our delta estimation machinery was built to solve.
4. **Faster** — 5-7x faster than tiktoken WASM. Not our bottleneck, but free.

**Risk**: Young library (4 months, ~28 stars). But clean code, MIT license, validated against tiktoken for correctness, and from Coder (a well-known company). The encoding data itself is deterministic BPE — the risk is in the JS implementation, not the token vocabulary.

## Proposed Overhaul

### Phase 1: Formalize Stateful Marker (PoC → Production)

Clean up the existing PoC code:

- **Define `CustomDataPartMimeTypes`** constant map (matching Microsoft's naming)
- **Stabilize the encoding**: Use the `modelId\JSON` format with `extension: "sferadev.vscode-ai-gateway"`
- **Reliable `previous_response_id`**: Set on every request where a marker is found, enabling OpenResponses server-side conversation context
- **Remove diagnostic logging**: Strip the JSONL diagnostic and `logger.warn` dumps
- **Update exclusion filters**: `digest.ts`, `counter.ts`, `message-translation.ts` already skip `stateful_marker`; verify they use the constant

### Phase 2: Simplify Token Counting (~3,000 lines removed)

Replace our delta estimation infrastructure with `ai-tokenizer`-based direct counting:

1. **Switch to `ai-tokenizer`**: Replace `js-tiktoken` with `ai-tokenizer`. Import `o200k_base` and `claude` encodings.
2. **Write new `TokenCounter`**: Single class with model-family → encoding mapping, per-part counting, image tile estimation. Use `ai-tokenizer`'s built-in LRU caching.
3. **Simplify `provideTokenCount`**: One-liner delegating to `TokenCounter.countTokens()`
4. **Simplify `estimateTotalInputTokens`**: Sum all messages + tool schema + system prompt overhead
5. **Delete**: `conversation-state.ts`, `sequence-tracker.ts`, `hybrid-estimator.ts`, `estimator.ts`, `validation-logger.ts`, `cache.ts` (and their tests)
6. **Keep**: `counter.ts` (rewrite as the new TokenCounter), `lru-cache.ts`
7. **Remove config**: Drop `tokensEstimationMode` and `tokensCharsPerToken` settings
8. **Claude accuracy**: Models using `anthropic/claude-*` families get the `claude` encoding with 1.10x multiplier calibration — first time we'll have accurate Claude token counts

### Phase 3: Thinking Block Persistence

Stream thinking blocks via `LanguageModelThinkingPart` and persist them via `DataPart('thinking')`:

- **Decision: Use `LanguageModelThinkingPart`** — The `chatProvider` proposed API we already implicitly use includes `LanguageModelThinkingPart` in `LanguageModelResponsePart2`. This is what GCMP does, and it's what VS Code expects — it provides proper UI rendering (thinking blocks are displayed differently from text), and VS Code automatically persists the thinking content as `DataPart('thinking')` in message history. Using DataPart-only would mean we handle persistence manually but lose the native UI treatment.
- **Emit during streaming**: When OpenResponses sends reasoning/thinking content, report `LanguageModelThinkingPart` via the `progress` callback. VS Code handles persistence automatically.
- **Persist via DataPart('thinking')**: In addition to ThinkingPart streaming, emit a `DataPart('thinking')` containing the thinking text, signature, and redacted token ID. This ensures the data survives round-trips even if VS Code's ThinkingPart persistence changes.
- **Reconstruct on next turn**: When building the API request, scan assistant messages for `thinking` DataParts and translate them back to Anthropic `thinking` blocks with signatures. This enables extended thinking to maintain coherence across turns.
- **Declare proposed API**: Add `"chatProvider"` to `enabledApiProposals` in `package.json` (we already use this API implicitly; making it explicit is the right thing to do)

### Phase 4: Prompt Caching Integration

The `cache_control` DataPart is already present in messages from VS Code (we see `DataPart(cache_control)` in diagnostics). Currently we skip it during translation. We should:

- **Pass through to OpenResponses**: Translate `cache_control` DataParts to Anthropic's `cache_control: { type: 'ephemeral' }` on the preceding content block
- **Emit on response**: Mirror VS Code's pattern by adding cache control breakpoints to our outgoing messages where appropriate
- **Depends on**: OpenResponses server supporting per-message cache_control (see `docs/bugs/ai-gateway-openresponses-anthropic-caching.md`)

### Phase 5: Context Management (Future)

Anthropic's context editing (`clear_tool_uses`, `clear_thinking`) would allow automatic context window management for long agent sessions. This is lower priority but the `context_management` DataPart provides the persistence mechanism when we're ready.

## Risks

1. **Undocumented API surface**: These MIME types are not in any public documentation. Microsoft could change the allowlist at any time. Mitigation: they won't break their own Copilot Chat extension, and GCMP has been shipping this for months.

2. **`modelId` rewriting**: VS Code may rewrite the modelId prefix in the `stateful_marker` encoding. We already handle this by reading from the JSON payload after the backslash, not from the prefix.

3. **Proposed API churn**: `chatProvider` is still proposed. If `LanguageModelThinkingPart` changes shape, our code breaks. Mitigation: the DataPart-based persistence format is more stable since it's just bytes.

## Files Modified (PoC, current state)

| File                                  | Change                                                      |
| ------------------------------------- | ----------------------------------------------------------- |
| `src/utils/stateful-marker.ts`        | New: encode/decode/find/log using GCMP's format             |
| `src/provider/stream-adapter.ts`      | Emit marker DataPart at `response.completed`                |
| `src/provider/openresponses-chat.ts`  | Read marker, set `previous_response_id`, diagnostic logging |
| `src/provider/message-translation.ts` | Skip `stateful_marker` DataParts during translation         |
| `src/tokens/counter.ts`               | Skip `stateful_marker` DataParts in token estimation        |
| `src/utils/digest.ts`                 | Exclude `stateful_marker` DataParts from digest hashing     |

## References

- `.reference/vscode-copilot-chat/src/platform/endpoint/common/endpointTypes.ts` — MIME constants
- `.reference/vscode-copilot-chat/src/platform/endpoint/common/statefulMarkerContainer.tsx` — Microsoft's marker implementation
- `.reference/vscode-copilot-chat/src/platform/endpoint/common/thinkingDataContainer.tsx` — Thinking persistence
- `.reference/vscode-copilot-chat/src/platform/networking/common/anthropic.ts` — Context editing types
- `.reference/vscode-copilot-chat/src/platform/endpoint/vscode-node/extChatEndpoint.ts` — Streaming with ThinkingPart + DataPart
- `.reference/GCMP/src/handlers/types.ts` — GCMP's copied MIME constants
- `.reference/GCMP/src/handlers/statefulMarker.ts` — GCMP's marker adaptation
- `.reference/GCMP/src/handlers/streamReporter.ts` — GCMP's unified streaming (ThinkingPart + marker emission)
- `docs/bugs/ai-gateway-openresponses-anthropic-caching.md` — Cache control gap analysis
