---
title: Assumption Validation Regime
stage: 0
feature: testing
exo:
  tool: exo rfc create
  protocol: 1
---

# RFC 00049: Assumption Validation Regime

**Status:** Idea  
**Priority:** High  
**Author:** Copilot  
**Created:** 2026-02-05

**Related:** 047 (Rolling Correction for provideTokenCount — Phases 4a/4b now complete), 029 (Delta-Based Token Estimation), 032 (Integration Test Harness)

## Problem

Our codebase makes critical assumptions about external behavior — how the Copilot extension calls `provideTokenCount`, how token sums influence summarization, how turn boundaries manifest as timing gaps. We have strong circumstantial evidence for these assumptions (production logs, VS Code source audits, API contracts), but **no automated tests that would break if the assumptions became false**.

This is an epistemological gap. Our proof tests verify internal consistency ("does `wouldStartNewSequence()` agree with `onCall()`?") but not external validity ("does the Copilot extension actually call us per-message in a tight loop?"). If Copilot ships an update that changes its calling pattern, we'd discover it through user-facing bugs rather than CI failures.

## Proposal

Establish a **formal assumption validation regime** — a structured approach to identifying, documenting, classifying, and testing the assumptions our system depends on.

### What This Is Not

This is not about increasing test coverage of our own code. We have unit tests for that. This is about **testing the boundary between our code and external systems whose behavior we depend on but don't control**.

## Taxonomy of Assumptions

### Level 1: Structural Assumptions (API contracts)

Things that would cause compile errors or obvious runtime failures if violated.

| ID  | Assumption                                                  | Evidence             | Current Validation  |
| --- | ----------------------------------------------------------- | -------------------- | ------------------- |
| S1  | `provideTokenCount` receives a single message (not a batch) | VS Code API types    | TypeScript compiler |
| S2  | `provideTokenCount` is called with the actual model object  | VS Code API contract | Smoke tests         |
| S3  | `maxInputTokens` is set on the model object                 | VS Code API          | Integration test    |

**Risk if wrong:** Immediate — code breaks visibly.
**Validation needed:** Minimal — TypeScript and existing tests cover this.

### Level 2: Behavioral Assumptions (calling patterns)

Things we infer from observation and source auditing. Would cause subtle, hard-to-diagnose bugs if violated.

| ID  | Assumption                                                                                                                 | Evidence                                 | Current Validation                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------- |
| B1  | Copilot calls `countTokens` once per message in a loop                                                                     | Production logs (134-289 calls/sequence) | **None (manual log inspection only)**                                           |
| B2  | All messages in a turn are counted in a single rapid burst (<500ms)                                                        | Production logs (sub-ms intra-turn gaps) | **None**                                                                        |
| B3  | Inter-turn gaps are always >500ms                                                                                          | Production logs (1.8s-84.5s observed)    | **None**                                                                        |
| B4  | `provideTokenCount` is called before `sendRequest` (not after)                                                             | Inference from VS Code source            | **None**                                                                        |
| B5  | Call count per sequence ≈ message count in conversation                                                                    | Production logs                          | **None**                                                                        |
| B6  | Copilot inserts a persistent `<conversation-summary>` user message at the start of the messages array after summarization  | VS Code Copilot Chat source audit        | `hasSummarizationTag()` detects it; summarization guard clears stale correction |
| B7  | Conversation identity (`extractIdentity`) resets after summarization because the first user message changes to the summary | Inference from `extractIdentity()` impl  | Implicit (dual-write to family key bridges the reset)                           |

**Risk if wrong:** Subtle — rolling correction silently returns wrong values, summarization doesn't trigger.
**Validation needed:** High — these are the assumptions the rolling correction depends on.

### Level 3: Semantic Assumptions (what the numbers mean)

Things we believe about how token counts are used by the consumer.

| ID  | Assumption                                                                                                    | Evidence                                | Current Validation                                                      |
| --- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| M1  | Copilot sums per-message token counts to get a total                                                          | Circumstantial (summarization behavior) | **None**                                                                |
| M2  | That total is compared against `maxInputTokens` for summarization                                             | Circumstantial                          | **None**                                                                |
| M3  | Our corrected estimates cause earlier/correct summarization                                                   | Not yet tested                          | **None**                                                                |
| M4  | `provideTokenCount()` receives no conversation identity, so rolling correction must use model-family-only key | VS Code API types (no context param)    | Dual-write in `recordActual()` + family-key lookup in `getAdjustment()` |

**Risk if wrong:** Feature doesn't work — but silently.
**Validation needed:** Medium — hardest to test, but most important for the feature.

## Validation Strategies

### Strategy 1: Sentinel Assertions (for B1-B5)

**What:** Instrument `provideTokenCount` to continuously validate behavioral assumptions during normal operation. When an assumption is violated, log a structured warning (and optionally surface it via telemetry).

**How:** Add a `BehaviorValidator` that sits alongside `CallSequenceTracker` and checks invariants on every call:

```
BehaviorValidator.onProvideTokenCount(args, timing):
  // B1: Are we receiving single messages?
  assert args.message is single message (not array)

  // B2: Are intra-turn gaps sub-500ms?
  if currentSequence && gap < SEQUENCE_GAP:
    assert gap < 100  // warn if intra-turn gap is suspiciously large

  // B3: Are inter-turn gaps >500ms?
  if currentSequence && gap > SEQUENCE_GAP:
    recordGap(gap)  // track for B3 validation

  // B4: Is this before or after sendRequest?
  // (can only validate if we correlate with request timing)

  // B5: Does call count match message count?
  // (validated post-hoc when we see the actual message count in sendRequest)
```

**Properties:**

- Runs in production (zero cost when assumptions hold)
- Fires immediately when an assumption breaks
- No flaky CI — validates real behavior
- Log-based: doesn't block, just warns

### Strategy 2: Integration Sentinels (for B4, M1-M3)

**What:** Extend the existing integration test harness (RFC 032, `packages/vscode-ai-gateway/src/test/suite/`) to include assumption-validating tests that run inside a real VS Code instance.

**How:**

```
test("B4: provideTokenCount called before sendRequest", async () => {
  // 1. Record timestamps of provideTokenCount calls
  // 2. Make a sendRequest through the VS Code LM API
  // 3. Assert all provideTokenCount calls happened BEFORE sendRequest started
});

test("B5: call count matches message count", async () => {
  // 1. Send a request with N messages
  // 2. Check that provideTokenCount was called exactly N times
  //    (or N+1 if system prompt is counted separately)
});
```

**Properties:**

- Runs in CI (via xvfb, already set up)
- Tests actual VS Code LM API behavior
- Can detect API behavior changes across VS Code updates

**Limitation:** These tests call `model.sendRequest()` directly, which exercises VS Code core's plumbing but NOT the Copilot extension's calling pattern. They validate S1-S3 and B4 but cannot validate B1-B3 or M1-M3 (those require Copilot to be the caller).

### Strategy 3: Forensic Regression Tests (for B1-B5)

**What:** Use forensic captures from real Copilot sessions as regression fixtures. When we capture a session, extract the behavioral invariants and store them as assertions.

**How:**

```
// From a real forensic capture, extract:
forensic-fixtures/
  2026-02-04-multi-turn.json:
    sequences: [
      { callCount: 147, totalTokens: 48738, gapAfter: 13068 },
      { callCount: 289, totalTokens: 113114, gapAfter: 6723 },
      { callCount: 138, totalTokens: 62150, gapAfter: 6720 },
    ]
    invariants:
      - all gaps > 500ms: true
      - all intra-burst gaps < 10ms: true
      - call counts monotonically increasing: true
```

**Properties:**

- Tests against real-world data
- Catches regressions in our interpretation of real behavior
- Can be updated when we get new captures after VS Code updates
- Doesn't require VS Code to run (pure unit tests over captured data)

### Strategy 4: Canary Metrics (for M1-M3)

**What:** After rolling correction is deployed, track whether summarization behavior actually changes. This is the ultimate end-to-end validation.

**Status:** Partially implemented. Rolling correction application and summarization detection are logged at info level (string-based). The remaining work is evolving these into structured JSON events that can be queried and correlated.

**How:**

```
// Log when rolling correction is applied:
logger.info("Rolling correction applied", {
  turn: N,
  adjustment: delta,
  correctedEstimate: total,
  uncorrectedEstimate: tiktoken_total,
});

// Log when summarization occurs (or doesn't):
// (detect via <conversation-summary> tag — already implemented)
logger.info("Summarization detected", {
  messagesBefore: prev_count,
  messagesAfter: curr_count,
  lastCorrectedEstimate: total,
  maxInputTokens: model.maxInputTokens,
});
```

**Properties:**

- Validates the end-to-end hypothesis
- Takes time to collect data (not immediate feedback)
- Most honest validation of M1-M3
- **Partially done:** Detection and basic logging exist; structured format and correlation remain

## Implementation Plan

### Phase 1: Sentinel Assertions (B1-B5)

1. Create `BehaviorValidator` class alongside `CallSequenceTracker`
2. Wire into `provideTokenCount` call path
3. Log structured warnings when invariants are violated
4. Add unit tests that the validator correctly flags violations

### Phase 2: Forensic Regression Fixtures

1. Write a script to extract behavioral invariants from forensic capture JSONL
2. Create fixture files from current production captures
3. Write unit tests that validate our parsing/interpretation against fixtures
4. Add to CI

### Phase 3: Integration Sentinels

1. Extend `packages/vscode-ai-gateway/src/test/suite/` with token-counting tests
2. Add tests for B4 (ordering) and B5 (count matching)
3. Run as part of `pnpm test:integration`

### Phase 4: Canary Metrics

1. Add structured logging for rolling correction application
2. Add summarization detection logging
3. Deploy and collect data
4. Analyze to validate M1-M3

## What This Doesn't Solve

**The Copilot black box.** The Copilot extension is closed-source. We cannot write a test that says "Copilot calls `countTokens` in a loop." We can only:

1. Observe the pattern in production (forensic captures, production logs)
2. Detect when the pattern changes (sentinel assertions)
3. Validate the end-to-end effect (canary metrics)

This is an inherent limitation. The regime doesn't eliminate the assumption gap — it **makes it visible and monitored** so we detect breakage early rather than through user-reported bugs.

## Appendix: Existing Infrastructure Inventory

_Captured 2026-02-05. Documents what testing infrastructure exists today and where the gaps are._

### What We Have

**1. Unit tests (Vitest)** — `apps/vscode-ai-gateway/` and `packages/vscode-ai-gateway/`

- 33 test files, 449 tests, all passing
- Includes `sequence-tracker.test.ts` (18 tests), `sequence-tracker-proof.test.ts` (7 proof tests), `conversation-state.test.ts` (summarization guard + dual-write), and `hybrid-estimator.test.ts` (key alignment + summarization integration)
- Tests internal logic only — no VS Code host, no real API calls

**2. Integration test harness** — `packages/vscode-ai-gateway/src/test/`

- Launches a real VS Code instance via `@vscode/test-electron`
- Custom test runner (no Mocha — replaced due to ESM/CJS incompatibility)
- xvfb wrapper for headless Linux: `scripts/test-integration.js`
- Has Fedora Silverblue-specific workarounds (isolated `--user-data-dir`)
- Current tests: smoke tests (extension loads, API available) + forensic capture tests (sendRequest protocol)
- **Gap:** No `provideTokenCount`-specific tests exist in the integration suite

**3. Forensic capture** — `packages/vscode-ai-gateway/src/provider/forensic-capture.ts`

- Captures detailed per-request data as JSONL: model info, message hashes, token estimates, options, raw dumps
- Enabled via `vercel.ai.debug.forensicCapture` setting
- **Critical blind spot:** Forensic capture fires on `sendRequest` (in `prepareAndSendRequest()` at `provider.ts:387`), NOT on `provideTokenCount`. Token counting calls leave no forensic trail — only `CallSequenceTracker` logs exist.

**4. Production logs** — `.logs/`

- `CallSequenceTracker.onCall()` logs "New sequence started" with gap, call count, and total tokens
- Format: `[timestamp] New sequence started (gap: Nms, previous: N calls, N tokens)`
- 114 entries in `previous.log` — this is our primary evidence for assumptions B1-B5
- These logs are text-based, not structured JSONL — parsing them for fixtures requires text extraction

**5. Log analysis scripts** — `packages/vscode-ai-gateway/scripts/`

- `analyze-forensic-captures.ts` — reads JSONL forensic data, provides summary/timeline views
- `analyze-agent-logs.ts`, `analyze-error-log.cjs` — other analysis tools
- **Gap:** No script exists to extract behavioral invariants from sequence tracker logs

### Key Gaps Identified

| Gap                                                  | Impact                                                      | Addressed By                                       | Status                                                                                                                                                   |
| ---------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No forensic capture of `provideTokenCount` calls     | Can't correlate token counting with sendRequest timing (B4) | Strategy 1 (Sentinel) + forensic capture extension | Open                                                                                                                                                     |
| Sequence tracker logs are unstructured text          | Can't easily create regression fixtures                     | Strategy 2 needs structured log format first       | Open                                                                                                                                                     |
| Integration tests don't exercise `provideTokenCount` | Can't validate B4/B5 in CI                                  | Strategy 2 (Integration Sentinels)                 | Open                                                                                                                                                     |
| ~~No summarization event detection~~                 | ~~Can't validate M1-M3~~                                    | ~~Strategy 4 (Canary Metrics)~~                    | **Resolved** — `hasSummarizationTag()` detects `<conversation-summary>` tag; summarization guard clears stale correction; info-level logging in provider |

### Infrastructure Added Since RFC Creation (RFC 047 Phases 4a/4b)

_Added 2026-02-05 during Phase 4 implementation._

**1. Summarization detection** — `conversation-state.ts`

- `hasSummarizationTag(messages)` — scans user messages for `<conversation-summary>` XML tag
- `extractPartText(part)` — handles both `LanguageModelTextPart` ({value}) and serialized ({type, text}) formats
- Detects summarization reliably via a persistent tag Copilot inserts after summarization (B6)

**2. Key alignment (dual-write)** — `conversation-state.ts`

- `recordActual()` writes to both per-conversation key (`"claude:<hash>"`) and model-family-only key (`"claude"`)
- Bridges the identity gap: `provideTokenCount()` can read family-key correction without conversation identity (M4)
- LRU eviction guard on first family-key insertion

**3. Summarization guard** — `conversation-state.ts` + `provider.ts`

- When `summarizationDetected` flag is set, `recordActual()` omits `lastSequenceEstimate` from the family key
- This causes `getAdjustment()` to return 0 (no stale correction applied)
- Provider detects summarization before API call and threads the flag through `onUsage` callback

**4. Production logging** — `provider.ts` + `hybrid-estimator.ts`

- Info-level log when summarization detected: `"Summarization detected in conversation"`
- Rolling correction application logged with adjustment value
- Partial coverage of Strategy 4 (Canary Metrics) — but logs are still string-based, not structured JSON

### VS Code Source Audit Findings

During RFC 047 development, we audited the VS Code source (`.reference/vscode/`) and found:

1. **`countTokens()` is plumbing only** — `LanguageModelChat.countTokens()` delegates directly to `provideTokenCount()` for a single message. There is no batching, caching, or looping in VS Code core.

2. **VS Code core uses `countTokens` only for tool invocations** — Found in `workbench/contrib/chat/` for counting tool call/result tokens. Not used for conversation-level summarization decisions.

3. **`maxInputTokens` is UI-only in core** — Used for the context usage percentage widget. The actual summarization threshold logic lives in the Copilot extension (closed source).

4. **No per-message loops in VS Code core** — The looping behavior we observe (134-289 rapid calls) must originate from the Copilot extension, which is closed source and not inspectable.

These findings are important context for Strategy 2 (Integration Sentinels): tests that call `model.sendRequest()` directly exercise VS Code core's plumbing, which does NOT loop over messages for token counting. Only Copilot-initiated requests produce the burst pattern we depend on. This limits what integration tests can validate.

## Success Criteria

1. **Every Level 2 assumption has at least one validation mechanism** (sentinel, fixture, or integration test)
2. **Assumption violations are logged** with enough context to diagnose
3. **New assumptions are documented** before code depending on them is merged
4. **Forensic fixtures are updated** when VS Code major versions ship

## References

- [RFC 047: Rolling Correction for provideTokenCount](./00047-rolling-correction-for-providetokencount.md) — Appendix: Verification Notes (A1-A3)
- [RFC 032: Integration Test Harness](./00032-integration-test-harness.md)
- [RFC 029: Delta-Based Token Estimation](./029-hybrid-token-estimator.md)
- [Forensic Capture Module](../../packages/vscode-ai-gateway/src/provider/forensic-capture.ts)
- [Integration Test Suite](../../packages/vscode-ai-gateway/src/test/suite/index.ts)
- [Integration Test Wrapper](../../packages/vscode-ai-gateway/scripts/test-integration.js)
- [Custom Test Runner](../../packages/vscode-ai-gateway/src/test/suite/index.ts) — No Mocha; custom runner due to ESM/CJS incompatibility
- [CallSequenceTracker](../../packages/vscode-ai-gateway/src/tokens/sequence-tracker.ts)
- [provideTokenCount impl](../../packages/vscode-ai-gateway/src/provider.ts) — Line 647, where forensic capture is absent
- [Forensic capture trigger](../../packages/vscode-ai-gateway/src/provider.ts) — Line 387, fires on sendRequest only
