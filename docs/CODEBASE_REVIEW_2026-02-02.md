# Codebase Review: vscode-ai-gateway

**Date:** February 2, 2026  
**Branch:** feat/token-status-bar  
**Reviewer:** AI Code Review Agent  
**Scope:** Full codebase audit focusing on correctness, reliability, and maintainability

---

## Executive Summary

This review identified **29 issues** across the vscode-ai-gateway extension codebase:

| Severity     | Count | Status           |
| ------------ | ----- | ---------------- |
| 🔴 Critical  | 4     | 3 FIXED, 1 open  |
| 🟠 Important | 11    | 3 FIXED, 8 open  |
| 🟡 Minor     | 14    | 0 fixed, 14 open |

**Key Findings:**

- ~~Tool-call state management can lose or mis-attribute tool invocations~~ ✅ FIXED
- ~~Session ID handling can split logs across multiple directories~~ ✅ FIXED
- Sensitive data (API keys, prompts) logged without redaction
- ~~Subagent detection has a bypass that causes 104% token display issues~~ ✅ FIXED
- Multiple unbounded caches can grow indefinitely in long-running sessions

---

## Critical Issues

### 1. Tool-call state keying allows overwrites

**Location:** [provider/stream-adapter.ts](packages/vscode-ai-gateway/src/provider/stream-adapter.ts)  
**Severity:** 🔴 Critical  
**Status:** ✅ FIXED

**Problem:**
The `StreamAdapter` class keyed function call state by `toolCallId` alone:

```typescript
/** Function calls being assembled from streaming deltas */
private functionCalls = new Map<string, FunctionCallState>();
```

The gateway can reuse `toolCallId` values across different responses. When this happens:

- Active tool calls can be overwritten mid-stream
- Tool invocations can be dropped entirely
- Tool results can be mis-attributed to the wrong call

**Impact:**

- Tool calls may fail silently
- Incorrect tool results returned to the model
- Debugging becomes extremely difficult

**Fix Applied:**

- Added `callIdToResponseId` reverse lookup map
- Added `getCallKey()` helper function that creates composite keys `${responseId}:${toolCallId}`
- Updated all function call handlers to use composite keys
- Added cleanup of reverse lookup when function calls complete

---

### 2. Session ID mismatch between RequestLogger and SessionManager

**Location:** [logger/request-logger.ts](packages/vscode-ai-gateway/src/logger/request-logger.ts), [logger/session-manager.ts](packages/vscode-ai-gateway/src/logger/session-manager.ts)  
**Severity:** 🔴 Critical  
**Status:** ✅ FIXED

**Problem:**
`RequestLogger` stored `sessionId` from its constructor options:

```typescript
// request-logger.ts line 36
this.sessionId = options.sessionId;
```

But `SessionManager` generates its own ID when not passed one:

```typescript
// session-manager.ts lines 27-30
constructor(indexWriter?: IndexWriter, sessionId?: string) {
  this.indexWriter = indexWriter ?? new IndexWriter();
  this.sessionId = sessionId ?? generateSessionId();
}
```

When `RequestLogger` created a default `SessionManager` without passing its `sessionId`:

```typescript
// request-logger.ts line 52
this.sessionManager =
  options.sessionManager ?? new SessionManager(this.indexWriter);
```

The `SessionManager` generated a different ID, causing:

- Session directory created with one ID
- Index entries written with a different ID
- Error entries potentially split across directories

**Impact:**

- Log analysis becomes unreliable
- Session reconstruction fails
- Debugging production issues is hampered

**Fix Applied:**
Changed line 55-56 to pass `this.sessionId` to `SessionManager` constructor:

```typescript
this.sessionManager =
  options.sessionManager ??
  new SessionManager(this.indexWriter, this.sessionId);
```

---

### 3. Sensitive data logged without redaction

**Location:** [logger/request-logger.ts](packages/vscode-ai-gateway/src/logger/request-logger.ts), [provider/forensic-capture.ts](packages/vscode-ai-gateway/src/provider/forensic-capture.ts)  
**Severity:** 🔴 Critical  
**Status:** ⚠️ Open

**Problem:**
Full request/response payloads are persisted as-is:

```typescript
// request-logger.ts - logRequest method
await fs.promises.writeFile(
  this.requestPath,
  JSON.stringify(requestBody, null, 2),
  "utf8",
);
```

```typescript
// forensic-capture.ts - captures full content when enabled
fullContent?: FullContentCapture;
```

This includes:

- System prompts (may contain proprietary instructions)
- User messages (may contain PII)
- API responses (may contain sensitive data)
- Tool call inputs/outputs

**Impact:**

- Security/compliance violations
- PII exposure in log files
- Potential credential leakage

**Recommendation:**

1. Implement a redaction layer before logging:

```typescript
function redactSensitiveData(data: unknown): unknown {
  // Redact known sensitive patterns
  // Hash or truncate long content
  // Remove authorization headers
}
```

2. Make forensic capture opt-in with clear warnings
3. Add log rotation and secure deletion

---

### 4. Subagent detection bypass causes 104% token display

**Location:** [status-bar.ts](packages/vscode-ai-gateway/src/status-bar.ts)  
**Severity:** 🔴 Critical  
**Status:** ✅ FIXED

**Problem:**
Subagent detection was gated by checking for pending claims AFTER checking `isNewConversation`:

```typescript
// status-bar.ts - startAgent method
const couldBeSubagent =
  (hasDifferentSystemPrompt || hasDifferentAgentType) && hasPendingClaims;
```

However, if a child agent starts with:

1. Same system prompt hash as parent (due to VS Code injecting summaries)
2. Same first user message hash

It would match via `partialKey` and be merged into the parent agent:

```typescript
const existingAgent = partialKey
  ? this.agentsByPartialKey.get(partialKey)
  : undefined;

if (existingAgent) {
  // Child gets merged into parent!
  this.agentIdAliases.set(agentId, existingAgent.id);
  // ...
}
```

This caused:

- Child tokens added to parent totals
- Token display can exceed 100% (e.g., "104%")
- Agent tree becomes incorrect

**Impact:**

- Misleading token usage display
- Incorrect billing/usage tracking
- Confusing user experience

**Fix Applied:**

- Changed the condition from `couldBeSubagent && agentTypeHash` to `hasPendingClaims && agentTypeHash`
- This ensures claims are checked FIRST, regardless of hash similarity
- Added regression test for the specific bug scenario (identical hashes with pending claim)

---

## Important Issues

### 5. System prompt duplication

**Location:** [provider/system-prompt.ts](packages/vscode-ai-gateway/src/provider/system-prompt.ts)  
**Severity:** 🟠 Important

**Problem:**
`buildSystemPrompt()` prepends a developer message when `instructions` exists AND returns `instructions`. OpenResponses receives both, duplicating the system prompt.

**Impact:**

- Inflated token usage
- Potential model confusion from duplicate instructions

**Recommendation:**
Return only one form of system prompt, not both.

---

### 6. Response-level errors not surfaced

**Location:** [provider.ts](packages/vscode-ai-gateway/src/provider.ts), [provider/openresponses-chat.ts](packages/vscode-ai-gateway/src/provider/openresponses-chat.ts)  
**Severity:** 🟠 Important

**Problem:**
`executeChat` can return `error` without throwing. The provider only handles exceptions:

```typescript
// Only exceptions are caught, not error responses
} catch (error) {
  // Handle error
}
```

Response-level failures don't trigger:

- Compaction/learned-token updates
- Status bar error display
- Proper error propagation

**Recommendation:**
Check `error` after `executeChat` returns and handle appropriately.

---

### 7. Message hash excludes name field

**Location:** [tokens/cache.ts](packages/vscode-ai-gateway/src/tokens/cache.ts)  
**Severity:** 🟠 Important  
**Status:** ✅ FIXED

**Problem:**

```typescript
digestMessage(message: vscode.LanguageModelChatMessage): string {
  const content = {
    role: message.role,
    parts: this.serializeParts(message.content),
    // NOTE: 'name' field is missing!
  };
```

Two messages with identical role/content but different `name` will hash to the same value, returning incorrect cached counts.

**Fix Applied:**
Added `name: message.name` to the content object in `digestMessage()`:

```typescript
const content = {
  role: message.role,
  name: message.name,
  parts: this.serializeParts(message.content),
};
```

---

### 8. Tool hash ignores content

**Location:** [tokens/sequence-tracker.ts](packages/vscode-ai-gateway/src/tokens/sequence-tracker.ts)  
**Severity:** 🟠 Important

**Problem:**
Tool calls/results are hashed using only `id`/`name`, ignoring input or result content. This can yield false "exact/prefix" matches and reuse stale actual token counts.

**Recommendation:**
Include tool input/output content in the hash.

---

### 9. Unbounded TokenCache

**Location:** [tokens/cache.ts](packages/vscode-ai-gateway/src/tokens/cache.ts)  
**Severity:** 🟠 Important

**Problem:**

```typescript
export class TokenCache {
  private cache = new Map<string, CachedTokenCount>();
  // No size limit, no eviction
}
```

In a long-lived extension process, this can grow indefinitely.

**Recommendation:**
Use an LRU cache with a maximum size (e.g., 10,000 entries).

---

### 10. Unbounded ConversationState.knownStates

**Location:** [tokens/conversation-state.ts](packages/vscode-ai-gateway/src/tokens/conversation-state.ts)  
**Severity:** 🟠 Important

**Problem:**

```typescript
private knownStates = new Map<string, KnownConversationState>();
// No TTL, no eviction
```

If `conversationId` changes frequently, this grows without bound.

**Recommendation:**
Add TTL-based eviction or maximum entry count.

---

### 11. Claim matching order prioritizes name over type-hash

**Location:** [identity/claim-registry.ts](packages/vscode-ai-gateway/src/identity/claim-registry.ts)  
**Severity:** 🟠 Important

**Problem:**

```typescript
// First, try to match by agent name (FIFO order)
for (const claim of validClaims) {
  if (claim.expectedChildAgentName === detectedAgentName) {
    // Match!
  }
}

// Second, try to match by type hash
```

When multiple pending claims share the same `name` but different `agentTypeHash`, the wrong claim can be matched.

**Recommendation:**
Match by `(name, agentTypeHash)` tuple first, then fall back to name-only or type-hash-only.

---

### 12. 64-bit hash truncation reduces collision resistance

**Location:** [identity/hash-utils.ts](packages/vscode-ai-gateway/src/identity/hash-utils.ts)  
**Severity:** 🟠 Important

**Problem:**

```typescript
return createHash("sha256")
  .update(...)
  .digest("hex")
  .substring(0, 16); // Only 64 bits!
```

All identity hashes are truncated to 16 hex chars (64 bits), reducing collision resistance significantly.

**Recommendation:**
Use at least 128 bits (32 hex chars) for identity hashes.

---

### 13. contextWindowSize overwritten when undefined

**Location:** [status-bar.ts](packages/vscode-ai-gateway/src/status-bar.ts)  
**Severity:** 🟠 Important  
**Status:** ✅ FIXED

**Problem:**
`updateAgentFromUsage()` overwrote `contextWindowSize` with `usage.contextWindowSize` even when the API omits it (returns undefined). This could drop a previously known limit.

**Fix Applied:**
Changed to use nullish coalescing to preserve existing value when undefined:

```typescript
agent.maxInputTokens = usage.maxInputTokens ?? agent.maxInputTokens;
```

---

### 14. clearAgents doesn't clear claims

**Location:** [status-bar.ts](packages/vscode-ai-gateway/src/status-bar.ts)  
**Severity:** 🟠 Important  
**Status:** ✅ FIXED

**Problem:**

```typescript
clearAgents(): void {
  this.agents.clear();
  this.agentsByConversationHash.clear();
  this.agentsByPartialKey.clear();
  this.agentIdAliases.clear();
  // NOTE: claimRegistry is NOT cleared!
}
```

Stale claims could influence future subagent matching and prevent parent removal via `hasChildrenInTree()`.

**Fix Applied:**
- Added `clearAll()` method to `ClaimRegistry`
- Call `this.claimRegistry.clearAll()` in `clearAgents()`
- Log `previousClaimCount` in debug output

---

### 15. Inconsistent warning threshold basis

**Location:** [status-bar.ts](packages/vscode-ai-gateway/src/status-bar.ts)  
**Severity:** 🟠 Important

**Problem:**

- Background warning uses `maxObservedInputTokens` for completed agents
- Elsewhere uses `estimatedInputTokens` for multi-turn context size

This inconsistency can under-warn on long-running conversations.

**Recommendation:**
Use a consistent metric for warning thresholds.

---

## Minor Issues

### 16. OIDC cancel surfaced as error

**Location:** [vercel-auth.ts](packages/vscode-ai-gateway/src/vercel-auth.ts)  
**Severity:** 🟡 Minor

User cancellation during OIDC flow is surfaced as an error toast instead of a graceful cancel.

---

### 17. Dead config watcher

**Location:** [config.ts](packages/vscode-ai-gateway/src/config.ts)  
**Severity:** 🟡 Minor

Status bar config watcher is effectively dead (hardcoded to `true`).

---

### 18. Misleading "Built" timestamp

**Location:** [extension.ts](packages/vscode-ai-gateway/src/extension.ts)  
**Severity:** 🟡 Minor

```typescript
const BUILD_TIMESTAMP = new Date().toISOString();
```

This generates the timestamp at activation time, not build time.

---

### 19. Missing URL validation

**Location:** [config.ts](packages/vscode-ai-gateway/src/config.ts)  
**Severity:** 🟡 Minor

`openResponsesBaseUrl` lacks validation for malformed URLs.

---

### 20. Broken markdown in deltas

**Location:** [provider/stream-adapter.ts](packages/vscode-ai-gateway/src/provider/stream-adapter.ts)  
**Severity:** 🟡 Minor

Refusal/reasoning deltas emitted as italicized chunks can produce broken markdown when split mid-word.

---

### 21. Tool result counting incomplete

**Location:** [tokens/counter.ts](packages/vscode-ai-gateway/src/tokens/counter.ts)  
**Severity:** 🟡 Minor

```typescript
private estimateToolResultTokens(part, modelFamily): number {
  for (const resultPart of part.content) {
    if (typeof resultPart === "object" && "value" in resultPart) {
      // Only counts parts with 'value' property
    }
  }
}
```

Ignores string or undefined results.

---

### 22. NaN estimates possible

**Location:** [tokens/estimator.ts](packages/vscode-ai-gateway/src/tokens/estimator.ts)  
**Severity:** 🟡 Minor

`contextWindowSize` cast without validation can produce NaN in calculations.

---

### 23. TTL expiry doesn't clear stored entry

**Location:** [persistence/store.ts](packages/vscode-ai-gateway/src/persistence/store.ts)  
**Severity:** 🟡 Minor

When TTL expires, the store returns defaults without clearing the stored entry.

---

### 24. Timer disposal not guaranteed

**Location:** [identity/claim-registry.ts](packages/vscode-ai-gateway/src/identity/claim-registry.ts)  
**Severity:** 🟡 Minor

Cleanup interval relies on callers to invoke `dispose()`. If not called, interval leaks.

---

### 25. No in-flight dedupe for model enrichment

**Location:** [models/enrichment.ts](packages/vscode-ai-gateway/src/models/enrichment.ts)  
**Severity:** 🟡 Minor

Concurrent calls for the same model trigger duplicate fetches.

---

### 26. Sync file I/O in IndexWriter

**Location:** [logger/index-writer.ts](packages/vscode-ai-gateway/src/logger/index-writer.ts)  
**Severity:** 🟡 Minor

Uses synchronous file operations that can block the extension host under load.

---

### 27. Log integrity risk

**Location:** [logger/index-writer.ts](packages/vscode-ai-gateway/src/logger/index-writer.ts)  
**Severity:** 🟡 Minor

Files written directly without temp+rename pattern. Crash during write can corrupt logs.

---

### 28. No session end marker

**Location:** [logger/session-manager.ts](packages/vscode-ai-gateway/src/logger/session-manager.ts)  
**Severity:** 🟡 Minor

No explicit session end marker makes lifecycle boundaries ambiguous.

---

### 29. Unbounded logs

**Location:** [logger/\*.ts](packages/vscode-ai-gateway/src/logger/)  
**Severity:** 🟡 Minor

Only `output.log` is rotated; other log files (`events.jsonl`, `errors.jsonl`) grow indefinitely.

---

## Recommendations

### Completed ✅

- ~~**Fix tool-call state keying**~~ - Keyed by `(responseId, toolCallId)` with reverse lookup
- ~~**Fix session ID mismatch**~~ - Now passes sessionId to SessionManager constructor
- ~~**Fix subagent detection bypass**~~ - Claims now checked before partialKey matching
- ~~**Fix message hash**~~ - Now includes `name` field for cache correctness
- ~~**Fix contextWindowSize overwrite**~~ - Preserves existing value when API returns undefined
- ~~**Fix clearAgents**~~ - Now clears pending claims via `claimRegistry.clearAll()`

### Immediate (Critical)

1. **Add sensitive data redaction** - Implement redaction layer before logging

### Short-term (Important)

5. Add LRU eviction to TokenCache and ConversationStateTracker
6. Improve claim matching to use `(name, agentTypeHash)` tuple
7. Handle response-level errors from `executeChat`

### Medium-term (Minor)

10. Add URL validation for config settings
11. Implement proper build timestamp injection
12. Add in-flight deduplication for model enrichment
13. Use temp+rename pattern for log writes
14. Add log rotation for all log files

---

## Appendix

### Files Reviewed

| File                           | Issues Found |
| ------------------------------ | ------------ |
| provider/stream-adapter.ts     | 2            |
| status-bar.ts                  | 5            |
| logger/request-logger.ts       | 2            |
| logger/session-manager.ts      | 2            |
| provider/forensic-capture.ts   | 1            |
| provider/system-prompt.ts      | 1            |
| provider.ts                    | 1            |
| provider/openresponses-chat.ts | 1            |
| tokens/cache.ts                | 2            |
| tokens/sequence-tracker.ts     | 1            |
| tokens/conversation-state.ts   | 1            |
| identity/claim-registry.ts     | 2            |
| identity/hash-utils.ts         | 1            |
| vercel-auth.ts                 | 1            |
| config.ts                      | 2            |
| extension.ts                   | 1            |
| tokens/counter.ts              | 1            |
| tokens/estimator.ts            | 1            |
| persistence/store.ts           | 1            |
| models/enrichment.ts           | 1            |
| logger/index-writer.ts         | 2            |

### Review Methodology

1. Static analysis of source files
2. Control flow analysis for state management
3. Data flow analysis for sensitive information
4. Concurrency analysis for race conditions
5. Memory analysis for unbounded growth
