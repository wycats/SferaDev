---
title: Thinking Interface — Implementation Map
feature: Unknown
exo:
    tool: exo rfc create
    protocol: 1
---

# RFC 00070: Thinking Interface — Implementation Map

RFC 00066: Interface-First API Alignment
Goal: design-thinking-interface, Task: map-implementations

## Interface → Implementation Mapping

### Implementation 1: ThinkingPartEmitter (Current — Provider-Side)

| Interface Method | Current Code | Notes |
|---|---|---|
| `isSupported` | `hasThinkingPartSupport()` in `synthetic-parts.ts:119` | Checks `vscode.LanguageModelThinkingPart !== undefined` |
| `createStreamingPart(text, id)` | `new LanguageModelThinkingPart(text, id)` in `stream-adapter.ts:954` | Cast to `unknown as LanguageModelResponsePart` because ThinkingPart not in stable union |
| `createPersistencePart(block)` | `encodeThinkingData({id, text})` → `new LanguageModelDataPart(encoded, "thinking")` in `stream-adapter.ts:1040-1048` | Returns `{data, mimeType: "thinking"}` |
| `recoverFromHistory(messages)` | `findThinkingData(messages)` in `stateful-marker.ts:196-222` | Scans DataPart('thinking') in assistant messages |
| `name` | `"thinking-part-emitter"` | — |

**Files touched:**
- `src/provider/synthetic-parts.ts` — `VSCodeThinkingPart`, `hasThinkingPartSupport()`, `toVSCodePart()` for thinking kind
- `src/provider/stream-adapter.ts:941-1050` — `flushThinkingBuffer()`, `endThinkingChain()`, `handleReasoningDelta()`, `handleReasoningDone()`
- `src/utils/stateful-marker.ts:130-222` — `ThinkingData`, `encodeThinkingData()`, `decodeThinkingData()`, `findThinkingData()`

**Dual emission pattern:**
1. During streaming: `LanguageModelThinkingPart` emitted via `flushThinkingBuffer()` (buffered, 20-char threshold)
2. At reasoning done: `DataPart('thinking')` emitted via `handleReasoningDone()` (complete block for persistence)

### Implementation 2: ChatResponseThinkingEmitter (Future — Participant-Side)

| Interface Method | Proposal API | Notes |
|---|---|---|
| `isSupported` | Always `true` (participant has ChatResponseStream) | — |
| `createStreamingPart(text, id)` | `ChatResponseStream.thinkingProgress({text, id})` | Uses `ThinkingDelta` type |
| `createPersistencePart(block)` | `undefined` | Participant-side persistence is managed by VS Code |
| `recoverFromHistory(messages)` | Scan `LanguageModelThinkingPart` in `LanguageModelChatMessage2.content` | ThinkingPart in message content (not DataPart) |
| `name` | `"chat-response-thinking"` | — |

**Prerequisite:** Extension must register as `ChatParticipant` to access `ChatResponseStream`. Same as identity and token interfaces.

**Key difference:** Participant-side uses `ChatResponseThinkingProgressPart` which has a `task` callback for progressive streaming. This is richer than provider-side but requires different emission architecture.

### Implementation 3: Stable ThinkingPart (Future — When API Stabilizes)

| Interface Method | Stable API | Notes |
|---|---|---|
| `isSupported` | Always `true` | ThinkingPart in stable `LanguageModelResponsePart` union |
| `createStreamingPart(text, id)` | `new LanguageModelThinkingPart(text, id)` | Same as current, but no cast needed |
| `createPersistencePart(block)` | `undefined` | VS Code persists ThinkingPart natively (no DataPart hack) |
| `recoverFromHistory(messages)` | Scan `LanguageModelThinkingPart` in message content | Direct access, no DataPart decoding |
| `name` | `"stable-thinking-part"` | — |

**Migration:** When `languageModelThinkingPart` enters stable API:
1. Remove `as unknown as LanguageModelResponsePart` casts
2. Remove `DataPart('thinking')` emission (persistence is native)
3. Remove `encodeThinkingData()`/`decodeThinkingData()` (no longer needed)
4. Update `recoverFromHistory()` to scan ThinkingPart directly
5. Remove `isMetadataMime()` check for 'thinking' MIME (no more DataParts)

## Consumer Migration Map

| Consumer | Current Usage | Migration |
|---|---|---|
| `stream-adapter.ts` | `new LanguageModelThinkingPart(text, id) as unknown as LanguageModelResponsePart` | `thinkingService.createStreamingPart(text, id)` |
| `stream-adapter.ts` | `encodeThinkingData({id, text})` + `new LanguageModelDataPart(...)` | `thinkingService.createPersistencePart({id, text})` — returns undefined when native |
| `stateful-marker.ts` | `findThinkingData(messages)` | `thinkingService.recoverFromHistory(messages)` |
| `synthetic-parts.ts` | `VSCodeThinkingPart`, `hasThinkingPartSupport()` | `thinkingService.isSupported` |
| `counter.ts` | `isMetadataMime("thinking")` → skip | Unchanged (still need to skip thinking DataParts in estimation) |

## Adoption Strategy

### Phase 1: Extract (No behavior change)
1. Create `ThinkingContentProvider` with `ThinkingPartEmitter` implementation
2. Replace inline `LanguageModelThinkingPart` construction with service calls
3. Replace inline `encodeThinkingData()`/`findThinkingData()` with service calls
4. All tests pass unchanged

### Phase 2: Simplify when stable
1. When `languageModelThinkingPart` enters stable API:
   - Remove DataPart('thinking') persistence hack
   - Remove ThinkingData encode/decode
   - Remove `as unknown` casts
   - `createPersistencePart()` returns undefined
   - `recoverFromHistory()` scans ThinkingPart directly

### Phase 3: Participant-side (Optional)
1. If participant registration is added (for chatSessionsProvider):
   - Add `ChatResponseThinkingEmitter` implementation
   - Use `ChatResponseStream.thinkingProgress()` for richer streaming
   - Keep provider-side as fallback
