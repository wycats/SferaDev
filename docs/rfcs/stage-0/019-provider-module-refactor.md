# RFC 019: Provider Module Refactoring

> **Stage**: 0 (Draft)
> **Status**: Planning
> **Purpose**: Decompose `openresponses-chat.ts` (1291 lines) into focused modules

## Problem Statement

The `provider/openresponses-chat.ts` file has grown to 1291 lines, mixing several distinct responsibilities:

1. **Request orchestration** (SSE streaming lifecycle)
2. **Message translation** (VS Code → OpenResponses format)  
3. **Message consolidation** (consecutive same-role merging)
4. **Image handling** (MIME detection from magic bytes)
5. **System prompt extraction** (role=3, disguised patterns)
6. **Debugging utilities** (suspicious request saving)

This violates SRP and makes the code harder to test, maintain, and extend.

---

## Current File Inventory

| File | Lines | Responsibility |
|------|-------|----------------|
| `provider/openresponses-chat.ts` | 1290 | Everything (problem) |
| `provider/stream-adapter.ts` | 1069 | SSE event → VS Code part adaptation |
| `provider/tool-history.ts` | 671 | Tool call deduplication (proposed API workaround) |
| `provider/synthetic-parts.ts` | 271 | Synthetic part generation |
| `provider/usage-tracker.ts` | ~100 | Token usage accumulation |
| `provider/index.ts` | ~20 | Module re-exports |

---

## Proposed Module Structure

### Phase 1: Extract Pure Functions (Low Risk)

These functions have **no dependencies** on VS Code APIs or external state. They can be extracted and unit-tested in isolation.

#### 1.1 `provider/image-utils.ts` (~50 lines)
```
function detectImageMimeType(data: Uint8Array, fallback: string): string
```

**Rationale**: Pure function, only depends on magic bytes lookup. No external imports.

#### 1.2 `provider/message-consolidation.ts` (~100 lines)
```
function consolidateConsecutiveMessages(items: ItemParam[]): ItemParam[]
```

**Rationale**: Already has comprehensive tests in `message-translation.test.ts`. Pure transformation function.

**Note**: The existing `message-translation.test.ts` should be renamed to `message-consolidation.test.ts` or split.

#### 1.3 `provider/debug-utils.ts` (~50 lines)
```
function saveSuspiciousRequest(body: CreateResponseBody, context: {...}): void
```

**Rationale**: Side-effecting but isolated. Only writes to `.logs/` directory. Used for debugging the "pause" issue.

---

### Phase 2: Extract Domain Logic (Medium Risk)

These functions involve message/role translation but are still relatively self-contained.

#### 2.1 `provider/system-prompt.ts` (~150 lines)
```
const VSCODE_SYSTEM_ROLE = 3

function extractSystemPrompt(messages: LanguageModelChatMessage[]): string | undefined
function extractMessageText(message: LanguageModelChatMessage): string | undefined  
function extractDisguisedSystemPrompt(message: LanguageModelChatMessage): string | undefined
```

**Rationale**: System prompt handling is a distinct concern. Currently interleaved with message translation.

#### 2.2 `provider/role-mapping.ts` (~30 lines)
```
function resolveOpenResponsesRole(role: LanguageModelChatMessageRole): 'user' | 'assistant'
function buildToolNameMap(messages: LanguageModelChatMessage[]): Map<string, string>
```

**Rationale**: Simple lookup functions. Could be inlined into translation module, but explicit naming aids comprehension.

#### 2.3 `provider/message-translation.ts` (~200 lines)
```
function translateMessage(msg: LanguageModelChatMessage, toolNameMap: Map<string, string>): ItemParam[]
function createMessageItem(role: string, content: ContentPart[]): ItemParam | null
```

**Rationale**: The core message translation logic. Depends on `role-mapping.ts` and `image-utils.ts`.

---

### Phase 3: Extract Request Layer (Higher Risk)

#### 3.1 `provider/request-builder.ts` (~80 lines)
```
function translateRequest(
  messages: LanguageModelChatMessage[],
  options: ProvideLanguageModelChatResponseOptions,
  configService: ConfigService
): {
  input: ItemParam[]
  instructions?: string
  tools: FunctionToolParam[]
  toolChoice: 'auto' | 'required' | 'none'
}
```

**Rationale**: Orchestrates the translation pipeline. Depends on `message-translation.ts`, `system-prompt.ts`, `message-consolidation.ts`.

#### 3.2 `provider/error-extraction.ts` (~60 lines)
```
function extractTokenInfoFromDetails(error: unknown): ExtractedTokenInfo | undefined
```

**Rationale**: Error parsing for token info. Currently buried at the end of the file.

---

### Phase 4: Slim Down Core Orchestrator

After extractions, `openresponses-chat.ts` becomes:

```typescript
// ~400 lines: SSE streaming orchestration ONLY
export interface OpenResponsesChatOptions { ... }
export interface OpenResponsesChatResult { ... }

export async function executeOpenResponsesChat(...): Promise<OpenResponsesChatResult> {
  // 1. Create client
  // 2. Call translateRequest() 
  // 3. Stream with StreamAdapter
  // 4. Handle cancellation, errors, finish reasons
  // 5. Extract usage/token info
}
```

**Dependencies**:
- `./request-builder.ts` (translateRequest)
- `./stream-adapter.ts` (StreamAdapter, AdaptedEvent)
- `./error-extraction.ts` (extractTokenInfoFromDetails)
- `./debug-utils.ts` (saveSuspiciousRequest)

---

## Dependency Graph (Post-Refactor)

```
openresponses-chat.ts
├── request-builder.ts
│   ├── message-translation.ts
│   │   ├── role-mapping.ts
│   │   └── image-utils.ts
│   ├── message-consolidation.ts
│   └── system-prompt.ts
├── stream-adapter.ts (existing)
├── error-extraction.ts
└── debug-utils.ts
```

---

## Implementation Strategy

### Incremental Approach

Each phase can be merged independently:

1. **Phase 1**: Extract pure functions → 3 small PRs
2. **Phase 2**: Extract domain logic → 3 small PRs  
3. **Phase 3**: Extract request layer → 2 PRs
4. **Phase 4**: Final cleanup → 1 PR

**Total**: 9 incremental PRs, each testable in isolation.

### Testing Strategy

- **Existing tests**: `message-translation.test.ts` already covers consolidation. Move tests with extracted functions.
- **New tests**: Add unit tests for `detectImageMimeType`, `extractSystemPrompt`, `extractDisguisedSystemPrompt`.
- **Integration**: Keep existing provider tests as integration tests.

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Breaking existing tests | Move tests alongside extracted functions |
| Import churn | Use barrel exports from `provider/index.ts` |
| Circular dependencies | Dependency graph is DAG (no cycles) |
| Merge conflicts | Small PRs, extract least-dependent first |

---

## Priority Order

**Recommended extraction order** (least→most dependent):

1. `image-utils.ts` (zero dependencies, pure)
2. `debug-utils.ts` (isolated side effect)
3. `message-consolidation.ts` (pure, already tested)
4. `role-mapping.ts` (tiny, pure)
5. `system-prompt.ts` (VS Code types only)
6. `message-translation.ts` (depends on 1, 4, 5)
7. `error-extraction.ts` (OpenResponsesError only)
8. `request-builder.ts` (orchestrates 3, 5, 6)
9. Final cleanup of `openresponses-chat.ts`

---

## Success Metrics

- [ ] No file in `provider/` exceeds 400 lines
- [ ] Each extracted module has dedicated test file
- [ ] All 236 existing tests pass
- [ ] Extension builds and installs without error
- [ ] No new lint/type errors introduced

---

## Open Questions

1. Should `synthetic-parts.ts` be merged into `message-translation.ts`?
2. Is `tool-history.ts` (671 lines) a separate refactoring target?
3. Do we want to extract types/interfaces into a `provider/types.ts`?

---

## Related

- Commit `1e83779`: Added proper function_call items
- [IMPLEMENTATION_CONSTRAINTS.md](../../../packages/openresponses-client/IMPLEMENTATION_CONSTRAINTS.md): Gateway behavior docs
