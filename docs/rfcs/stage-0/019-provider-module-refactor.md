# RFC 019: Provider Module Refactoring

> **Stage**: 0 (Draft)  
> **Status**: ✅ Complete  
> **Purpose**: Decompose `openresponses-chat.ts` (1291 lines) into focused modules

## Completion Summary (2026-01-31)

### Commits
- `54b4777` - Phase 1: Extract pure functions
- `1a67ad3` - Phase 2: Extract domain logic
- `fe8928c` - Phase 3: Extract request layer
- `454be63` - Phase 4: Final cleanup
- `b94837d` - Slop cleanup

### Final Module Structure
| File | Lines | Responsibility |
|------|-------|----------------|
| `openresponses-chat.ts` | 410 | Orchestration only |
| `request-builder.ts` | 137 | Request translation |
| `message-translation.ts` | 193 | Message conversion |
| `message-consolidation.ts` | 95 | Same-role merging |
| `system-prompt.ts` | 132 | System prompt extraction |
| `error-extraction.ts` | 70 | Token info from errors |
| `image-utils.ts` | 66 | MIME detection |
| `debug-utils.ts` | 49 | Suspicious request saving |
| **Total** | **1152** | Down from 1291 |

### Test Coverage
- Tests: 236 → 293 (+57 tests)
- Test files: 14 → 21 (+7 files)

---

## Decisions (2026-01-31)

Based on prepare agent review and user decisions:

1. **Test-first approach**: Write tests alongside each phase (closes coverage gaps)
2. **Merge small modules**: Avoid 22-line files; merge into semantically relevant larger files
3. **Slop review at end**: After all extractions, review for cruft and AI slop patterns (e.g., 100-line `createMessageItem` is suspicious)
4. **`role-mapping.ts` merged**: Into `message-translation.ts` (too small standalone)
5. **`createMessageItem` placement**: In `message-translation.ts` (tightly coupled)

---

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

| File                             | Lines | Responsibility                                    |
| -------------------------------- | ----- | ------------------------------------------------- |
| `provider/openresponses-chat.ts` | 1291  | Everything (problem)                              |
| `provider/stream-adapter.ts`     | 1069  | SSE event → VS Code part adaptation               |
| `provider/tool-history.ts`       | 671   | Tool call deduplication (proposed API workaround) |
| `provider/synthetic-parts.ts`    | 271   | Synthetic part generation                         |
| `provider/usage-tracker.ts`      | ~100  | Token usage accumulation                          |
| `provider/index.ts`              | ~20   | Module re-exports                                 |

---

## Proposed Module Structure (Revised)

### Phase 1: Extract Pure Functions (Low Risk)

These functions have **no dependencies** on VS Code APIs or external state.

#### 1.1 `provider/image-utils.ts` (~60 lines)

```typescript
function detectImageMimeType(data: Uint8Array, fallback: string): string;
```

**Tests needed**: Magic byte detection for PNG, JPEG, GIF, WebP, and fallback behavior.

#### 1.2 `provider/message-consolidation.ts` (~90 lines)

```typescript
function consolidateConsecutiveMessages(items: ItemParam[]): ItemParam[];
```

**Tests needed**: Role merging, non-message item passthrough, empty input handling.

#### 1.3 `provider/debug-utils.ts` (~35 lines)

```typescript
function saveSuspiciousRequest(body: CreateResponseBody, context: {...}): void
```

**Tests needed**: None (side-effect only, debugging utility).

---

### Phase 2: Extract Domain Logic (Medium Risk)

#### 2.1 `provider/system-prompt.ts` (~115 lines)

```typescript
const VSCODE_SYSTEM_ROLE = 3;

function extractSystemPrompt(
  messages: readonly LanguageModelChatMessage[],
): string | undefined;
function extractMessageText(
  message: LanguageModelChatMessage,
): string | undefined;
function extractDisguisedSystemPrompt(
  message: LanguageModelChatMessage,
): string | undefined;
```

**Tests needed**: Role=3 detection, disguised prompt heuristics.

#### 2.2 `provider/message-translation.ts` (~250 lines)

```typescript
// Includes role-mapping functions (merged, too small standalone)
function resolveOpenResponsesRole(
  role: LanguageModelChatMessageRole,
): "user" | "assistant";
function buildToolNameMap(
  messages: readonly LanguageModelChatMessage[],
): Map<string, string>;
function translateMessage(
  msg: LanguageModelChatMessage,
  toolNameMap: Map<string, string>,
): ItemParam[];
function createMessageItem(
  role: string,
  content: ContentPart[],
): ItemParam | null;
```

**Tests needed**: Part type handling, function_call/function_call_output emission.
**Flag for review**: `createMessageItem` is ~100 lines—likely has slop.

---

### Phase 3: Extract Request Layer (Higher Risk)

#### 3.1 `provider/request-builder.ts` (~150 lines)

```typescript
function translateRequest(
  messages: readonly LanguageModelChatMessage[],
  options: ProvideLanguageModelChatResponseOptions,
  configService: ConfigService,
): {
  input: ItemParam[];
  instructions?: string;
  tools: FunctionToolParam[];
  toolChoice: "auto" | "required" | "none";
};
```

**Tests needed**: Tool translation, system prompt injection, consolidation integration.

#### 3.2 `provider/error-extraction.ts` (~60 lines)

```typescript
function extractTokenInfoFromDetails(
  error: unknown,
): ExtractedTokenInfo | undefined;
```

**Tests needed**: Structured error parsing, fallback behavior.

---

### Phase 4: Final Cleanup

After extractions, `openresponses-chat.ts` becomes:

```typescript
// ~400 lines: SSE streaming orchestration ONLY
export interface OpenResponsesChatOptions { ... }
export interface OpenResponsesChatResult { ... }

export async function executeOpenResponsesChat(...): Promise<OpenResponsesChatResult>
```

**Post-extraction tasks**:

- [ ] Slop review of all extracted modules
- [ ] Identify and simplify over-engineered functions
- [ ] Remove dead code paths

---

## Dependency Graph (Post-Refactor)

```
openresponses-chat.ts
├── request-builder.ts
│   ├── message-translation.ts
│   │   └── image-utils.ts
│   ├── message-consolidation.ts
│   └── system-prompt.ts
├── stream-adapter.ts (existing)
├── error-extraction.ts
└── debug-utils.ts
```

---

## Implementation Strategy

### Approach: prepare → execute → review → commit

For each phase:

1. **Prepare agent**: Audit extraction targets, identify edge cases
2. **Execute agent**: Perform extraction with tests
3. **Review agent**: Verify correctness, check for issues
4. **Commit**: One commit per phase

### Extraction Order (Revised)

| Order | Module                     | Lines | Dependencies            |
| ----- | -------------------------- | ----- | ----------------------- |
| 1     | `image-utils.ts`           | ~60   | None                    |
| 2     | `debug-utils.ts`           | ~35   | fs only                 |
| 3     | `error-extraction.ts`      | ~60   | OpenResponsesError type |
| 4     | `system-prompt.ts`         | ~115  | VS Code types           |
| 5     | `message-consolidation.ts` | ~90   | ItemParam types         |
| 6     | `message-translation.ts`   | ~250  | 1, 4                    |
| 7     | `request-builder.ts`       | ~150  | 5, 6                    |
| 8     | Final cleanup              | —     | Slim main file          |

---

## Success Metrics

- [ ] No file in `provider/` exceeds 400 lines
- [ ] Each extracted module has dedicated test file
- [ ] All existing tests pass (236+)
- [ ] Extension builds and installs without error
- [ ] No new lint/type errors introduced
- [ ] Slop review completed post-extraction

---

## Open Questions (Resolved)

1. ~~Should `synthetic-parts.ts` be merged?~~ → Out of scope
2. ~~Is `tool-history.ts` a separate target?~~ → Out of scope, separate RFC if needed
3. ~~Extract types to `provider/types.ts`?~~ → No, keep co-located

---

## Related

- Commit `1e83779`: Added proper function_call items
- [IMPLEMENTATION_CONSTRAINTS.md](../../../packages/openresponses-client/IMPLEMENTATION_CONSTRAINTS.md): Gateway behavior docs
