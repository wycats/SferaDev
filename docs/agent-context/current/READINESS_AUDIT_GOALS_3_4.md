# Readiness Audit: RFC 041 Goals 3-4 (Hallucination Defense)

**Date**: 2026-02-03  
**Auditor**: Agent  
**Status**: Ready to Proceed with Corrections

---

## Executive Summary

Goals 3-4 (Hallucination Defense) are **80% ready** for implementation. The foundational Capsule module (Goals 1-2) is complete with full test coverage. The hallucination detection logic and tests already exist. However, there are **2 critical corrections needed** regarding **where and how** to integrate CapsuleGuard into the stream pipeline.

**Key Finding**: The RFC specifies integration into `VSCodeStreamAdapter.handle()`, but the actual stream architecture shows `VSCodeStreamAdapter` is a **stateless event mapper**, not a stream controller. Hallucination defense must hook at a **higher level** in `executeOpenResponsesChat()` to access the cancellation token.

---

## Verified Assumptions ✅

### 1. **Capsule Module is Complete**

- ✅ `src/identity/capsule.ts` exists with all required functions
  - `formatCapsule()` - converts Capsule → HTML comment
  - `parseCapsule()` - converts HTML comment → Capsule
  - `extractCapsuleFromContent()` - scans message for capsule
  - `removeCapsuleFromContent()` - strips capsule from content
  - `appendCapsuleToContent()` - adds capsule to content
  - `detectHallucinatedCapsule()` - pattern detection
  - `getStreamBuffer()` - rolling buffer extraction
  - `generateConversationId()` / `generateAgentId()` - ID generation

- ✅ Full test coverage in `src/identity/capsule.test.ts` (421 lines)
  - Format/parse roundtrip tests
  - Content operations (extract, remove, append)
  - Hallucination detection patterns
  - Edge cases (empty buffer, malformed input)

### 2. **Hallucination Detection Logic is Proven**

- ✅ `detectHallucinatedCapsule()` function already implemented and tested
- ✅ Pattern detection for `<!-- v.cid:`, `<!-- v.aid:`, `<!-- v.pid:` works correctly
- ✅ Default buffer size of 20 chars is appropriate
- ✅ Test case: `detectHallucinatedCapsule("text... <!-- v.cid:")` → `true`

### 3. **Stream Infrastructure Exists**

- ✅ `src/provider/openresponses-chat.ts` has:
  - Streaming request loop: `for await (const event of client.createStreamingResponse())`
  - Text delta event handling
  - Cancellation token support via `abortController.signal`
  - `progress.report()` callback for emitting parts

- ✅ `src/provider/stream-adapter.ts` has:
  - `StreamAdapter` class with `adapt(event)` method
  - Text delta handling in `handleTextDelta(event)`
  - State management for text content (buffers maintained)
  - All 24 OpenResponses event types explicitly handled

- ✅ Cancellation mechanism available:
  - VS Code `CancellationToken` passed to function
  - `AbortController` created and linked to cancellation token
  - `abortController.abort()` can stop the stream

---

## Corrections Needed ⚠️

### **Correction 1: Integration Point (CRITICAL)**

**Issue**: RFC specifies integration into `VSCodeStreamAdapter.handle()` method, but this class doesn't exist with that signature.

**Reality**:

- `StreamAdapter` (not "VSCodeStreamAdapter") is a **stateless event adapter**
- Its `adapt(event)` method is purely functional—it doesn't maintain stream state
- It has **no access to cancellation tokens** or stream control
- The actual stream loop is in `executeOpenResponsesChat()` at line 248-253

**RFC Quote (incorrect)**:

```typescript
// In StreamAdapter or openresponses-chat.ts
class CapsuleGuard { ... }
```

**Correction**: CapsuleGuard must hook **in `executeOpenResponsesChat()`**, not in the adapter:

```typescript
// Current code (line 248-253):
for await (const event of client.createStreamingResponse(
  requestBody,
  abortController.signal,
)) {
  // ← THIS is where CapsuleGuard hooks, not in StreamAdapter
  const adapted = adapter.adapt(event);
  // ... emit parts ...
}
```

**Implementation Location**:

- Create `CapsuleGuard` class in `src/provider/stream-adapter.ts` or new file `src/provider/capsule-guard.ts`
- Instantiate `guard = new CapsuleGuard()` before the loop (line 248)
- Call `guard.onTextDelta(text, () => abortController.abort())` when emitting text parts

---

### **Correction 2: Stream Buffer Maintenance (IMPORTANT)**

**Issue**: The RFC example shows a simple buffer, but real implementation needs clarification.

**Reality**:

- `StreamAdapter` already maintains `textContent` Map (line 100-106) for state
- But `CapsuleGuard` needs its **own rolling buffer**, independent of adapter state
- The buffer should track **cumulative deltas since last event check**

**Why**:

- Text deltas come in chunks: `"Hello"`, `" "`, `"world"`
- Need to check the boundary where hallucination might start
- Pattern `<!-- v.cid:` could span multiple deltas

**Implementation**:

```typescript
class CapsuleGuard {
  private buffer = "";
  private readonly maxBufferSize = 30;

  onTextDelta(text: string, onHallucination: () => void): string {
    this.buffer = (this.buffer + text).slice(-this.maxBufferSize);

    if (detectHallucinatedCapsule(this.buffer)) {
      onHallucination(); // This will call abortController.abort()
      // Return truncated text (stop at hallucination start)
      return this.truncateAtHallucination(text);
    }

    return text; // Pass through unchanged
  }

  reset(): void {
    this.buffer = "";
  }
}
```

---

## Blockers 🔴

### **No Hard Blockers**

All dependencies are satisfied:

- ✅ Capsule core module exists (Goals 1-2 complete)
- ✅ Cancellation token infrastructure exists
- ✅ Text delta handling exists
- ✅ Stream loop accessible for hooks

---

## Architecture Diagram

```
executeOpenResponsesChat()
  ↓
  for await (event of client.createStreamingResponse(...)) {
    ↓
    ┌─────────────────────────────────────────────┐
    │ ← CapsuleGuard HOOKS HERE (not in adapter)  │
    │   - Intercepts text deltas BEFORE adaptation│
    │   - Maintains rolling buffer (30 chars)    │
    │   - Calls abortController.abort() if match │
    │   - Returns truncated text if hallucination│
    └─────────────────────────────────────────────┘
    ↓
    const adapted = adapter.adapt(event)
      ↓
      [StreamAdapter: pure functional event mapping]
    ↓
    progress.report(part) // Emit to VS Code
  }
```

---

## Implementation Order Recommendation 📋

### Phase: Goals 3-4 Execution (Recommended Sequence)

#### Step 1: Create CapsuleGuard Class

**File**: `src/provider/capsule-guard.ts` (new file)
**Effort**: 30 min
**Complexity**: Low

```typescript
import { detectHallucinatedCapsule } from "../identity/capsule.js";

/**
 * Monitors text stream for hallucinated capsule patterns and triggers
 * cancellation if detected.
 */
export class CapsuleGuard {
  private buffer = "";
  private readonly maxBufferSize = 30;

  onTextDelta(
    text: string,
    onHallucination: () => void,
  ): { text: string; hallucinated: boolean } {
    this.buffer = (this.buffer + text).slice(-this.maxBufferSize);

    if (detectHallucinatedCapsule(this.buffer)) {
      onHallucination();
      const truncated = this.truncateAtHallucination(text);
      return { text: truncated, hallucinated: true };
    }

    return { text, hallucinated: false };
  }

  private truncateAtHallucination(text: string): string {
    // Find where pattern starts in this delta
    const match = text.match(/<!-- v\./);
    if (match?.index !== undefined) {
      return text.substring(0, match.index);
    }
    return text;
  }

  reset(): void {
    this.buffer = "";
  }
}
```

#### Step 2: Integrate into executeOpenResponsesChat()

**File**: `src/provider/openresponses-chat.ts`
**Effort**: 45 min
**Complexity**: Medium (state management)

**Location**: Modify the stream loop (lines 248-320)

```typescript
// After abortController creation (line 144):
const guard = new CapsuleGuard();

// Inside stream loop, when handling text deltas:
const adapted = adapter.adapt(event);

for (const part of adapted.parts) {
  if (part instanceof LanguageModelTextPart) {
    const guardResult = guard.onTextDelta(part.value, () => {
      abortController.abort();
    });

    if (guardResult.hallucinated) {
      logger.warn(
        `[OpenResponses] Hallucinated capsule detected, cancelling stream`,
      );
      // Don't emit the truncated part, just stop
      break;
    }

    progress.report(new LanguageModelTextPart(guardResult.text));
  } else {
    progress.report(part);
  }
}

// In finally block (line 496):
guard.reset();
```

#### Step 3: Write Integration Tests

**File**: `src/provider/capsule-guard.test.ts` (new file)
**Effort**: 1 hour
**Complexity**: Medium

Test cases:

- ✅ `onTextDelta()` with safe text (no hallucination)
- ✅ Pattern match across deltas: `"text... "` + `"<!-- v.cid:"`
- ✅ Truncation at hallucination start point
- ✅ Buffer rolling (keep last 30 chars)
- ✅ Callback firing on detection
- ✅ Reset clears buffer

#### Step 4: Add E2E Test to openresponses-chat.test.ts

**File**: `src/provider/openresponses-chat.test.ts`
**Effort**: 45 min
**Complexity**: Medium

Mock scenario:

- Model generates: `"Hello world<!-- v.cid:malicious"`
- Stream should be cancelled at `"Hello world"`
- Verify `abortController.abort()` was called
- Verify no hallucinated capsule appears in output

---

## Dependency Map

```
Goals 3-4 Implementation
├── Depends On: Goals 1-2 (✅ Complete)
│   └── Capsule.ts module
│   └── detectHallucinatedCapsule() function
│
├── Depends On: Existing Infrastructure (✅ Available)
│   ├── executeOpenResponsesChat() stream loop
│   ├── CancellationToken & AbortController
│   ├── progress.report() callback
│   └── StreamAdapter event handling
│
└── Required Imports:
    ├── "../identity/capsule.js" → detectHallucinatedCapsule
    ├── "vscode" → LanguageModelTextPart
    └── "../logger.js" → logger
```

---

## Risk Assessment

| Risk                                                      | Severity | Mitigation                                                                 |
| --------------------------------------------------------- | -------- | -------------------------------------------------------------------------- |
| Hallucination detection fires spuriously (false positive) | Medium   | Extensive testing with real models, production monitoring                  |
| Truncation loses context                                  | Low      | Pattern is unique (`<!-- v.cid:`), unlikely to appear in legitimate output |
| Buffer performance (string concat)                        | Low      | 30-char buffer is tiny; negligible overhead                                |
| Cancellation doesn't propagate                            | Low      | Uses proven VS Code CancellationToken + AbortController pattern            |
| Tests pass locally but fail in E2E                        | Medium   | Mock streaming scenarios with boundary conditions                          |

---

## Success Criteria (Testable)

1. ✅ `CapsuleGuard.onTextDelta("<!-- v.cid:")` → `{ text: "", hallucinated: true }`
2. ✅ `CapsuleGuard.onTextDelta("safe text")` → `{ text: "safe text", hallucinated: false }`
3. ✅ Pattern matches across deltas: buffer maintains last 30 chars
4. ✅ Integration test: stream aborts when pattern detected
5. ✅ No false positives on common text (HTML comments in user input)
6. ✅ Unit test coverage > 95% for new code

---

## Next Steps

1. **Prepare Phase** (This Audit):
   - ✅ Verified assumptions
   - ✅ Identified 2 corrections (integration point, buffer handling)
   - ✅ Provided implementation roadmap
   - ✅ Cleared blockers

2. **Execute Phase**:
   - Create `CapsuleGuard` class per Step 1
   - Integrate into `executeOpenResponsesChat()` per Step 2
   - Write tests per Steps 3-4

3. **Review Phase**:
   - Verify all test cases pass
   - Check for regressions (streaming still works for normal responses)
   - Validate no performance impact

---

## Questions Resolved

### Q: What if the model completes the capsule before we truncate?

**A**: Detection happens on deltas, not complete patterns. The moment `<!-- v.cid:` appears, we abort.

### Q: Can CapsuleGuard be placed elsewhere?

**A**: No. Must be in the **stream loop** where we have:

1. Access to each text delta
2. Access to `abortController.abort()`
3. Ability to mutate the reported text

### Q: Should CapsuleGuard state be per-request or global?

**A**: Per-request. Create new instance in `executeOpenResponsesChat()`, reset in finally block.

### Q: What about tool calls and reasoning content?

**A**: Hallucination defense only applies to **text deltas** (the visible content). Tool calls use function_call_arguments events, which have different structure and aren't user-facing.

---

## Appendix: Code Locations Reference

| Component          | File                                 | Lines   | Status           |
| ------------------ | ------------------------------------ | ------- | ---------------- |
| Capsule module     | `src/identity/capsule.ts`            | 1-180   | ✅ Complete      |
| Capsule tests      | `src/identity/capsule.test.ts`       | 1-421   | ✅ Complete      |
| Stream loop        | `src/provider/openresponses-chat.ts` | 248-320 | ← Hook here      |
| StreamAdapter      | `src/provider/stream-adapter.ts`     | 155-250 | Reference only   |
| Text delta handler | `src/provider/stream-adapter.ts`     | 741-750 | Stateless mapper |
| Abort setup        | `src/provider/openresponses-chat.ts` | 144-149 | Existing         |

---

**Status**: 🟢 **READY TO PROCEED** (with corrections noted above)
