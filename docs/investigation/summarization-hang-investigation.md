# Summarization Hang Investigation

> **Status**: Active investigation
> **Started**: 2026-02-09
> **Methodology**: `/sci` — Observation → Hypothesis → Prediction → Experiment

---

## 1. The Observation (What We Actually See)

**Symptom**: Conversations with Vercel-routed models hang during summarization. Copilot's own models (e.g., `copilot-chat`) do not hang.

**What "hang" means**: Not yet precisely characterized. Could be:

- Model takes extremely long to respond (minutes)
- Copilot enters a summarization retry loop
- Our provider throws errors that Copilot doesn't handle gracefully
- Copilot never triggers summarization for its own models (different threshold)

**Mitigation in place**: 120s streaming inactivity timeout (breaks the hang, doesn't fix root cause).

---

## 2. The Fact Base (What We Know From Code)

### 2.1 How Copilot Summarizes — Two Distinct Code Paths

There are **two separate summarization systems** in Copilot. Understanding which one applies is critical.

#### Path A: `ChatSummarizerProvider` (via VS Code API)

**File**: `vscode-copilot-chat/src/extension/prompt/node/summarizer.ts`

- Registered as `defaultAgent.summarizer` on the Copilot chat participant
- Called by VS Code core via `ChatParticipant.summarizer` proposed API
- **Always uses `copilot-fast` endpoint** — NOT the user's selected model
- Calls `endpoint.makeChatRequest('summarize', messages, ...)` directly
- Simple: renders summary prompt, sends to copilot-fast, returns string

**When it runs**: VS Code core calls `provideChatSummary()` when it determines the conversation history is too long. This is for the **chat panel history** — VS Code manages when to call it.

#### Path B: `ConversationHistorySummarizer` (agent mode, during prompt rendering)

**File**: `vscode-copilot-chat/src/extension/prompts/node/agent/summarizedConversationHistory.tsx`

- Called from `agentIntent.ts` `buildPrompt()` when `BudgetExceededError` is thrown
- **Uses the currently selected endpoint** — which IS our extension model when it's selected
- Calls `endpoint.makeChatRequest2({ stream: false, temperature: 0, tool_choice: 'none' })`
- Has fallback: if `forceGpt41` experiment is enabled AND gpt-4.1's `modelMaxPromptTokens >= endpoint.modelMaxPromptTokens`, uses gpt-4.1 instead
- On failure: falls back to rendering with no cache breakpoints and original endpoint (no summarization)

**When it runs**: During `agentIntent.ts` `buildPrompt()`. The flow:

1. Compute `safeBudget = floor((baseBudget - toolTokens) * 0.85)`
2. For Anthropic models with context editing: check previous turn's `promptTokens + outputTokens` vs threshold
3. Try to render prompt with budget
4. If `BudgetExceededError` → trigger `renderWithSummarization()`
5. `SummarizedConversationHistory.render()` → creates `ConversationHistorySummarizer`
6. Summarizer sends request to the endpoint (our provider) with `{ stream: false, temperature: 0 }`

**THIS IS THE PATH THAT MATTERS FOR US.** When users pick our extension model, Path B calls our provider for summarization.

### 2.2 How `ExtensionContributedChatEndpoint` Wraps Our Provider

**File**: `vscode-copilot-chat/src/platform/endpoint/vscode-node/extChatEndpoint.ts`

When our extension model is selected, Copilot wraps it in `ExtensionContributedChatEndpoint`:

```typescript
// Key properties:
get modelMaxPromptTokens(): number { return this._maxTokens; } // = languageModel.maxInputTokens
get maxOutputTokens(): number { return 8192; }  // HARDCODED — not from our provider
get tokenizer(): TokenizerType { return TokenizerType.O200K; } // DEFAULT — not from our provider

// makeChatRequest2 calls:
const response = await this.languageModel.sendRequest(vscodeMessages, vscodeOptions, token);
// Then iterates response.stream and builds ChatResponse with:
usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } }
// ALWAYS ZEROS
```

**Critical observations**:

1. `maxOutputTokens` hardcoded to 8192 — doesn't use our model's actual value
2. `tokenizer` defaults to O200K — doesn't consider our model family
3. `requestOptions` (including `stream: false`) are **NOT passed through** to `sendRequest()`
4. Usage is **always zeroed** — Copilot gets no actual token counts back

### 2.3 How Token Counting Works for Extension Models

**File**: `vscode-copilot-chat/src/platform/endpoint/vscode-node/extChatTokenizer.ts`

Copilot uses `ExtensionContributedChatTokenizer` for extension models:

- `tokenLength(text)` → calls `this.languageModel.countTokens(text)` — which calls our `provideTokenCount()`
- `countMessageTokens(message)` → converts to VS Code format, calls `countTokens()` on the VS Code message object
- `countToolTokens(tools)` → 16 base + 8/tool + counted object tokens, × 1.1

**This means**: Copilot's summarization budget depends on OUR `provideTokenCount()` implementation. If it's wrong, the budget is wrong.

### 2.4 The Summarization Budget Formula (from agentIntent.ts)

```typescript
const baseBudget = Math.min(
  configThreshold ?? endpoint.modelMaxPromptTokens,
  endpoint.modelMaxPromptTokens,
);
const budgetThreshold = Math.floor((baseBudget - toolTokens) * 0.85);
```

For our models: `baseBudget = maxInputTokens = min(enriched_context, 128000)`. So with 40 tools at ~50k tokens, the budget is roughly `floor((128000 - 50000) * 0.85) = 66300`.

### 2.5 What Our Provider Reports

| Property              | Value                                                          | Source                                                                     |
| --------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `maxInputTokens`      | min(enriched context_length, 128,000)                          | `CONSERVATIVE_MAX_INPUT_TOKENS` cap                                        |
| `maxOutputTokens`     | varies by model                                                | enrichment, but Copilot IGNORES this (hardcodes 8192)                      |
| `provideTokenCount()` | ai-tokenizer encoding (o200k for OpenAI, claude for Anthropic) | `TokenCounter` class                                                       |
| Temperature           | 0.1                                                            | Hardcoded (Copilot sends 0 for summarization, but it's not passed through) |
| Streaming             | Always `true`                                                  | Hardcoded in `requestBody`                                                 |

### 2.6 Validation Log Data

We write estimate-vs-actual to `.logs/token-validation.jsonl`. This is our primary empirical data source for accuracy analysis.

---

## 3. Hypotheses (Revised Based on Reference Code Analysis)

### H1: `provideTokenCount()` inaccuracy causes incorrect budget threshold

**Theory**: If our token estimates are systematically wrong (too high or too low), Copilot's summarization threshold (`budgetThreshold`) triggers at the wrong time.

**Mechanism**: Copilot calls our `provideTokenCount()` via `ExtensionContributedChatTokenizer`. The results drive `PromptRenderer`'s budget calculation. If we over-count, `BudgetExceededError` is thrown too early (triggers premature but benign summarization). If we under-count, prompts grow past model limits before summarization triggers → "input too long" error.

**Testable**: YES — analyze `.logs/token-validation.jsonl`.

**Prediction**: If delta is consistently positive (we over-estimate), summarization triggers earlier but shouldn't hang. If delta is consistently negative (we under-estimate), context grows too large, API returns error, and error handling path may hang.

### H2: Summarization request goes through our provider and hangs

**Theory (CONFIRMED as real code path)**: When Path B runs, `ConversationHistorySummarizer` calls `endpoint.makeChatRequest2()` on our `ExtensionContributedChatEndpoint`, which calls `this.languageModel.sendRequest()` → our `provideLanguageModelChatResponse()`. Our provider always streams with `temperature: 0.1`, ignoring the `stream: false, temperature: 0` from the summarization request.

**The request properties ARE NOT passed through.** `ExtensionContributedChatEndpoint.makeChatRequest2()` does:

```typescript
const vscodeOptions = { tools: ... }; // ONLY tools, no temperature/stream
const response = await this.languageModel.sendRequest(vscodeMessages, vscodeOptions, token);
```

The summarization request arrives at our provider as a normal chat request with the full history + summary prompt, but:

- Our temperature is 0.1 instead of the requested 0
- We stream instead of returning a single response
- The full prompt may be very large (entire conversation history)

**Testable**: YES — add request-shape logging to detect summarization requests.

**Prediction**: We'd see large requests (full conversation + summary instructions) arriving at our provider, and the model takes a long time to process them because the context is huge.

### H3: The hang IS the model processing a huge summarization prompt

**Theory**: The summarization prompt includes the ENTIRE conversation history (that's what's being summarized). For a 128k-context conversation, the summarization request might itself be close to 128k tokens. The model needs to:

1. Read the entire history (~128k tokens of input)
2. Generate a comprehensive summary (~5-10k tokens of output)

This could take 60-180 seconds, which appears as a "hang."

Meanwhile, Copilot may cancel or timeout if our streaming response doesn't produce output fast enough.

**Testable**: YES — time-to-first-token logging.

**Prediction**: TTFT for summarization requests is 30-120s (model thinking time on huge prompts). Our 120s inactivity timeout is borderline — sometimes kills legitimate requests.

### H4: ~~Zero usage from ExtensionContributedChatEndpoint~~ (DEPRIORITIZED)

The `usage: { prompt_tokens: 0 }` return was a concern, but reading the code carefully, Copilot measures the summary SIZE using `this.sizing.countTokens(response.value)` — it counts the tokens in the summary text, not the usage from the request. So zeroed usage from our provider does NOT affect the post-summarization budget check.

However: the `handleSummarizationResponse` does check:

```typescript
if (summarySize > effectiveBudget) {
  throw new Error("Summary too large");
}
```

This uses `this.sizing.countTokens()` which goes through our `provideTokenCount()` again. If our counting is wrong, the summary could be rejected as "too large" → fallback → potential loop.

### H5: Copilot's `forceGpt41` experiment bypasses the hang for built-in models

**Theory**: The `AgentHistorySummarizationForceGpt41` experiment config, when enabled, makes Copilot use `gpt-4.1` for summarization instead of the selected model. This only applies when `gpt41Endpoint.modelMaxPromptTokens >= endpoint.modelMaxPromptTokens`. For built-in models, this means summarization goes through Copilot's own fast infrastructure. For extension models, it would only apply if gpt-4.1's max prompt tokens are ≥ ours.

This could explain the differential: Copilot's own models may use gpt-4.1 for summarization (fast, optimized), while our extension model does not qualify for the override, so summarization goes through our slower provider.

**Testable**: PARTIALLY — we can't check if the experiment is enabled, but we can observe whether summarization requests reach our provider.

---

## 4. Experiment Plan (Revised — Ordered by Information Yield)

### Experiment 1: Analyze Validation Logs ✅ COMPLETE

**Tests**: H1 (token counting accuracy)
**Method**: Analyzed `.logs/token-validation.jsonl` — 112 unique new-format entries (with `deltaPct`).
**Effort**: Zero code changes. Pure data analysis.

#### Results

| Metric                     | Value               |
| -------------------------- | ------------------- |
| Total entries (new format) | 112                 |
| Under-estimate rate        | **90%** of requests |
| Mean deltaPct              | **-11.4%**          |
| Median deltaPct            | **-14.7%**          |
| Mean absolute delta        | **-11,361 tokens**  |

**Error by model:**

| Model           | Entries | Mean % | Median % | Range            | Under-est |
| --------------- | ------- | ------ | -------- | ---------------- | --------- |
| claude-opus-4.5 | 75      | -10.4% | -13.3%   | [-17.0%, +4.3%]  | 88%       |
| claude-opus-4.6 | 18      | -15.7% | -14.9%   | [-19.8%, -14.8%] | 100%      |

**Error by context size (linear regression, R²=0.46):**

| Actual Tokens | Predicted Error | We Report |
| ------------- | --------------- | --------- |
| 10k           | -5.9%           | ~9.4k     |
| 20k           | -6.8%           | ~18.6k    |
| 50k           | -9.5%           | ~45.3k    |
| 80k           | -12.1%          | ~70.3k    |
| 100k          | -13.9%          | ~86.1k    |
| 128k          | -16.4%          | ~107k     |

**Size-dependent pattern (claude-opus-4.5):**

- Small (<20k): mean error +1.1% (slight OVER-estimate)
- Large (≥50k): mean error -15.6% (severe under-estimate)

**Per-conversation drift**: Every unique chatId has exactly 1 validation entry (per-request logging), but entries are clearly from progressive conversation turns. Error degrades monotonically as context grows within what appears to be the same conversation replayed.

#### Interpretation

1. **The token counter is accurate for text** — at 18k tokens, estimate is within 1%. The `ai-tokenizer` Claude encoding works.
2. **Something scales with conversation size that we don't count**. The error is proportional (~0.9%/10k tokens additional), not a fixed offset. This rules out a single missing constant overhead.
3. **Most likely cause**: Anthropic's API counts structural overhead (message framing, tool schema XML formatting, system prompt wrapping) that grows with the number of messages/tool-uses. Our per-message overhead of 3 tokens is likely far too low for Anthropic's actual message formatting.
4. **Impact on summarization**: Copilot's budget threshold fires based on our estimates. At 100k actual tokens, we report ~86k. Copilot thinks there's ~14k of headroom left and keeps adding history turns. By the time summarization triggers, the prompt is significantly oversized → slow model processing or API errors.

#### Conclusion

**H1 is CONFIRMED**: `provideTokenCount()` systematically under-estimates by 10-17% for Anthropic models at typical conversation sizes. This directly impacts the summarization budget threshold, causing it to fire too late.

### Experiment 2: Add Summarization Detection + TTFT Logging ✅ IMPLEMENTED

**Tests**: H2, H3 (summarization through our provider, model processing time)
**Method**: Added to `openresponses-chat.ts`:

1. `detectSummarizationRequest()` — detects by content: last user message contains "Summarize the conversation history" OR system message contains SummaryPrompt markers
2. TTFT measurement — `performance.now()` from request start to first content part
3. Total duration logging on stream completion
4. Enhanced timeout logging with summarization flag and TTFT

**Log tags**: `[OpenResponses] SUMMARIZATION REQUEST DETECTED`, `SUMMARIZATION TTFT`, `SUMMARIZATION COMPLETE`

**What to look for in logs**:

- Does summarization actually hit our provider? (DETECTED log)
- TTFT: how long before model starts responding? (TTFT log)
- Total request duration? (COMPLETE log)
- Does the 120s timeout kill legitimate summarization requests? (timeout log with `summarization=true`)

**Status**: Code deployed, awaiting log data from next summarization trigger.

### Experiment 3: Enumerate All Available Models ⬜

**Tests**: H5 (model limit differential)
**Method**: At startup or via diagnostic command, log all `vscode.lm.selectChatModels()` results with their `maxInputTokens`.
**Effort**: ~10 lines.
**Decision**: Compare our 128k cap against Copilot models. If Copilot models are 200k+, they hit summarization threshold much later.

### Experiment 4: Test Summarization with Explicit Timeout Increase ⬜

**Tests**: H3 (is it just slow?)
**Method**: Temporarily increase STREAM_INACTIVITY_TIMEOUT_MS to 300s (5min) and see if summarization completes.
**Effort**: 1 line change.
**Decision**: If summarization completes at 300s, the issue is purely TTFT latency.

---

## 5. Log

_Entries recorded as experiments are run._

| Date       | Experiment                     | Result                                                | Conclusion                                                    |
| ---------- | ------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------- |
| 2026-02-09 | Exp 1: Validation logs         | -11.4% mean, -14.7% median under-est, 90% of requests | H1 CONFIRMED: systematic under-count scales with context size |
| 2026-02-09 | Exp 2: Summarization detection | Code deployed, awaiting trigger                       | Will confirm H2/H3 on next summarization event                |
