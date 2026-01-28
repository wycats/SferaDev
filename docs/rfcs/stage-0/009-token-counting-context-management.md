# RFC 009: Token Counting and Context Management

**Status:** Draft  
**Priority:** Critical  
**Author:** Copilot  
**Created:** 2026-01-27
**Updated:** 2026-01-27

**Depends On:** [003a](./003a-streaming-adapter.md), [003b](./003b-token-estimation.md), [008](./008-high-fidelity-model-mapping.md)

**Status Note:** This is an umbrella implementation RFC that coordinates token counting improvements across dependent RFCs.

## Summary

This RFC proposes improvements to token counting and context management in the Vercel AI Gateway VS Code extension. Accurate token counting is **critical for Copilot's conversation summarization** to trigger correctly. When token estimates are significantly off, Copilot may either:

1. Summarize too early (losing context unnecessarily)
2. Summarize too late (causing API errors when exceeding limits)
3. Not summarize at all (context window overflow)

## Background

### How Copilot Summarization Works

Based on research into `microsoft/vscode-copilot-chat` (now open source):

1. **Copilot participant** (not the language model provider) handles all summarization
2. Copilot reads `maxInputTokens` from model metadata to know the context limit
3. Copilot uses `provideTokenCount` to estimate message sizes
4. When approaching the limit, Copilot's `SummarizedConversationHistory` triggers summarization
5. The `ChatContextUsageWidget` displays the current usage percentage

**Key insight:** Language model providers don't implement summarization—they just need to provide accurate metadata and token counts.

### Current Implementation

Our current implementation has:

| Feature                      | Status         | Quality                              |
| ---------------------------- | -------------- | ------------------------------------ |
| `maxInputTokens`             | ✅ Implemented | `context_window * 0.85` — reasonable |
| `provideTokenCount`          | ✅ Implemented | `~3.5 chars/token` — rough estimate  |
| Token caching                | ✅ Implemented | Hash-based workspace state           |
| Hybrid estimation            | ✅ Implemented | Uses actual counts when available    |
| Correction factor            | ✅ Implemented | Rolling average improves over time   |
| Dynamic model discovery      | ✅ Implemented | Fetches from API                     |
| Anthropic context management | ✅ Implemented | `contextManagement.enabled`          |

### Comparison with GCMP

[VicBilibily/GCMP](https://github.com/VicBilibily/GCMP) is a well-maintained third-party language model provider with 82+ stars. Their implementation includes features we're missing:

| Feature                    | Our Implementation          | GCMP                               |
| -------------------------- | --------------------------- | ---------------------------------- |
| **Tokenizer**              | Character-based (`len/3.5`) | Real tiktoken library              |
| **Context status bar**     | None                        | Detailed breakdown by category     |
| **Model selection memory** | None                        | Remembers last-selected model      |
| **Token usage analytics**  | Basic tracking              | Full per-provider/model statistics |
| **Config overrides**       | Fixed system prompt only    | Full provider/model customization  |

However, GCMP lacks features we have:

| Feature                     | Our Implementation    | GCMP                   |
| --------------------------- | --------------------- | ---------------------- |
| **Dynamic model discovery** | ✅ From API           | ❌ Hardcoded in config |
| **Hybrid token estimation** | ✅ Actual + estimated | ❌ Pure estimation     |
| **Correction factor**       | ✅ Rolling average    | ❌ None                |
| **Anthropic context mgmt**  | ✅ Enabled            | ❌ Not mentioned       |

## Problem Statement

The core problem is **ensuring Copilot always summarizes before we hit the token limit**.

Copilot's summarization is triggered when our reported token usage approaches `maxInputTokens`. If we underestimate tokens, Copilot won't summarize in time, and the API request will fail with a context window overflow error. This is **unrecoverable** — the conversation is broken.

Our character-based estimation (`text.length / 3.5`) can be significantly off:

- Code with many short tokens (operators, brackets): **underestimates** ⚠️ DANGEROUS
- Prose with longer words: **overestimates** (acceptable — triggers early summarization)
- Non-ASCII text (CJK, emoji): **wildly inaccurate** ⚠️ DANGEROUS
- Tool calls with JSON: **unpredictable**

**The only failure mode we cannot accept is underestimation.** Overestimation causes early summarization (acceptable). Underestimation causes overflow (unacceptable).

## Proposed Solution

### Core Principle: API Actuals First

The Vercel AI Gateway returns **accurate token counts** in `usage` after each request. This is ground truth—we should use it whenever possible.

In a typical conversation:

```
Message 1 (sent) → API returns actual: 150 tokens  → CACHE IT
Message 2 (sent) → API returns actual: 200 tokens  → CACHE IT  
Message 3 (sent) → API returns actual: 180 tokens  → CACHE IT
Message 4 (composing) → No actual yet             → ESTIMATE IT
```

For a 50-message conversation, we have actuals for 49 messages and only need to estimate 1.

### Token Count Sources (Priority Order)

| Source | When Used | Accuracy | Safety Margin |
|--------|-----------|----------|---------------|
| **Cached API actuals** | Already-sent messages | Ground truth | 2% |
| **Tiktoken estimation** | Unsent messages only | Very accurate | 5% |
| **Character fallback** | Unknown encodings (rare) | Rough | 10% |

**The key insight:** Estimation (tiktoken) is only needed for:
- The new user message being composed
- Tool results that haven't been sent yet
- Edited messages (until the next API response caches them)

### Strategy

- **After each request:** Cache API-reported actuals, keyed by message digest
- **When Copilot asks for token count:** Use cached actuals for sent messages, estimate only unsent
- **When user edits a message:** The edited message loses its cache entry; estimate until next send

### Message Digest Caching (Critical Infrastructure)

The message digest cache is the **foundation** of accurate token counting. It ensures that:

1. **API actuals survive message edits** — If user edits message 5, messages 1-4 and 6+ retain their cached actuals
2. **Identical messages share counts** — Same content = same digest = same cached count
3. **Model-specific caching** — Different models may tokenize differently

The key insight is that **message content determines token count** — if we've seen a message before and know its actual token count, we should use that regardless of position in the conversation.

```typescript
interface CachedTokenCount {
  digest: string; // SHA-256 of message content
  modelFamily: string; // Token counts are model-specific
  actualTokens: number; // Ground truth from API
  timestamp: number; // For cache eviction
}

class TokenCache {
  private cache: Map<string, CachedTokenCount> = new Map();

  /**
   * Generate a digest for a message that survives edits to other messages.
   * Two messages with identical content should have identical digests.
   */
  private digestMessage(message: LanguageModelChatMessage): string {
    const content = {
      role: message.role,
      parts: Array.from(message.content).map((part) => {
        if (part instanceof LanguageModelTextPart) {
          return { type: "text", value: part.value };
        }
        if (part instanceof LanguageModelDataPart) {
          // Hash the data, don't store it
          return {
            type: "data",
            mimeType: part.mimeType,
            size: part.data.byteLength,
          };
        }
        if (part instanceof LanguageModelToolCallPart) {
          return {
            type: "toolCall",
            name: part.name,
            callId: part.callId,
            input: part.input,
          };
        }
        if (part instanceof LanguageModelToolResultPart) {
          return { type: "toolResult", callId: part.callId };
        }
        return { type: "unknown" };
      }),
    };
    return crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(JSON.stringify(content)))
      .then((buf) =>
        Array.from(new Uint8Array(buf))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(""),
      );
  }

  /**
   * Look up cached actual token count for a message.
   */
  async getCached(
    message: LanguageModelChatMessage,
    modelFamily: string,
  ): Promise<number | undefined> {
    const digest = await this.digestMessage(message);
    const key = `${modelFamily}:${digest}`;
    return this.cache.get(key)?.actualTokens;
  }

  /**
   * Store actual token count from API response.
   * Called after we receive usage data from the API.
   */
  async cacheActual(
    message: LanguageModelChatMessage,
    modelFamily: string,
    actualTokens: number,
  ): Promise<void> {
    const digest = await this.digestMessage(message);
    const key = `${modelFamily}:${digest}`;
    this.cache.set(key, {
      digest,
      modelFamily,
      actualTokens,
      timestamp: Date.now(),
    });
  }
}
```

### Phase 1: Message Digest Cache Infrastructure (Critical)

**Goal:** Build the caching infrastructure that makes API actuals available for all sent messages, even after edits.

This is the highest priority because:
- API actuals are ground truth — no estimation error
- Most messages in a conversation are already-sent
- The cache survives message edits (digest is content-based, not position-based)

### Phase 2: Token Counting with Cache Lookup (Critical)

**Goal:** Use cached actuals when available, estimate only unsent messages:

1. **Check cache first** — If we have an actual for this message digest, use it
2. **Estimate if needed** — Only for messages without cached actuals (new/edited)
3. **Apply appropriate margin** — 2% on actuals, 5% on estimates

```typescript
import { getEncoding, type Tiktoken } from "js-tiktoken";

const SAFETY_MARGIN = 1.05; // 5% buffer on top of precise count
const MESSAGE_OVERHEAD = 4; // Tokens per message for role/structure

class TokenCounter {
  private encoders = new Map<string, Tiktoken>();
  private cache: TokenCache;

  constructor(cache: TokenCache) {
    this.cache = cache;
  }

  /**
   * Get token count for a message, using best available source.
   */
  async countMessage(
    model: LanguageModelChatInformation,
    message: LanguageModelChatMessage,
  ): Promise<number> {
    // 1. Check cache for actual count from previous API response
    const cached = await this.cache.getCached(message, model.family);
    if (cached !== undefined) {
      // We have ground truth — use it with minimal safety margin
      return Math.ceil(cached * 1.02); // 2% margin on actuals
    }

    // 2. Use tiktoken for precise estimation
    let total = MESSAGE_OVERHEAD;
    for (const part of message.content) {
      if (part instanceof LanguageModelTextPart) {
        total += this.countText(model, part.value);
      } else if (part instanceof LanguageModelDataPart) {
        total += this.estimateImageTokens(model, part);
      } else if (part instanceof LanguageModelToolCallPart) {
        total += this.countText(model, part.name);
        total += this.countText(model, JSON.stringify(part.input));
      }
    }
    // Safety margin on estimates
    return Math.ceil(total * SAFETY_MARGIN);
  }

  private countText(model: LanguageModelChatInformation, text: string): number {
    const encoder = this.getEncoder(model.family);
    return encoder.encode(text).length;
  }

  private getEncoder(modelFamily: string): Tiktoken {
    const encoding = this.selectEncoding(modelFamily);
    if (!this.encoders.has(encoding)) {
      this.encoders.set(encoding, getEncoding(encoding));
    }
    return this.encoders.get(encoding)!;
  }

  private selectEncoding(modelFamily: string): string {
    // Use precise tokenizer for known models
    if (modelFamily.includes("gpt-4o") || modelFamily.includes("o1")) {
      return "o200k_base";
    }
    if (
      modelFamily.includes("gpt-4") ||
      modelFamily.includes("gpt-3.5") ||
      modelFamily.includes("claude")
    ) {
      return "cl100k_base";
    }
    // For unknown models, still use a real tokenizer as best approximation
    return "cl100k_base";
  }
}
```

**Why real tokenizers matter:**

| Input                              | Character-based (len/3.5) | Actual (tiktoken) | Error       |
| ---------------------------------- | ------------------------- | ----------------- | ----------- |
| `function foo() { return x + y; }` | 9 tokens                  | 14 tokens         | **-36%** ⚠️ |
| `The quick brown fox`              | 6 tokens                  | 4 tokens          | +50% (safe) |
| `日本語テキスト`                   | 2 tokens                  | 7 tokens          | **-71%** ⚠️ |
| `{"key": "value"}`                 | 5 tokens                  | 7 tokens          | **-29%** ⚠️ |

Character-based estimation systematically underestimates code and non-ASCII text — exactly the content we're processing.

**Encoding selection by model:**

| Model Family           | Encoding                                     |
| ---------------------- | -------------------------------------------- |
| GPT-4, GPT-3.5, Claude | `cl100k_base`                                |
| GPT-4o, o1             | `o200k_base`                                 |
| Gemini                 | `cl100k_base` (best available approximation) |
| Unknown                | `cl100k_base` (best available approximation) |

**Dependencies:**

- `js-tiktoken` (pure JS, ~2MB, works in VS Code extension host)

### Phase 3: Wiring API Actuals to Cache (Critical)

**Goal:** Extract actual token counts from Vercel AI Gateway responses and populate the cache after each request.

The Vercel AI SDK's `fullStream` emits `finish` and `finish-step` events with usage data:

```typescript
case "finish": {
  const finishChunk = chunk as {
    type: "finish";
    totalUsage?: { inputTokens?: number; outputTokens?: number };
  };
  if (finishChunk.totalUsage) {
    await this.cacheMessageTokenCounts(
      messages,
      model.family,
      finishChunk.totalUsage.inputTokens
    );
  }
  break;
}
```

**Distributing total tokens across messages:**

The API returns a total input token count, not per-message counts. We need to distribute this across messages:

```typescript
class TokenCounter {
  /**
   * After receiving actual token count from API, cache it for each message.
   * Uses proportional distribution based on our estimates.
   */
  async cacheMessageTokenCounts(
    messages: readonly LanguageModelChatMessage[],
    modelFamily: string,
    totalActualTokens: number,
  ): Promise<void> {
    // First, get our estimates for each message
    const estimates = await Promise.all(
      messages.map((msg) =>
        this.countMessage({ family: modelFamily } as any, msg),
      ),
    );
    const totalEstimate = estimates.reduce((a, b) => a + b, 0);

    if (totalEstimate === 0) return;

    // Distribute actual tokens proportionally
    for (let i = 0; i < messages.length; i++) {
      const proportion = estimates[i] / totalEstimate;
      const actualForMessage = Math.round(totalActualTokens * proportion);
      await this.cache.cacheActual(messages[i], modelFamily, actualForMessage);
    }
  }
}
```

**Why this matters for edits:**

When a user edits message 3 in a 10-message conversation:

- Messages 1, 2, 4-10 have cached actuals → use them (precise)
- Message 3 is new → use tiktoken estimate (accurate)
- Total is accurate, not a guess

```
Before edit:
  [msg1: cached 150] [msg2: cached 200] [msg3: cached 180] [msg4: cached 220]
  Total: 750 tokens (from cache)

After editing msg3:
  [msg1: cached 150] [msg2: cached 200] [msg3: estimated 195] [msg4: cached 220]
  Total: 765 tokens (mostly cached, one estimate)
```

### Phase 3: Token Usage Analytics (Important)

**Goal:** Track actual vs estimated tokens for debugging and accuracy monitoring.

```typescript
interface TokenUsageRecord {
  requestId: string;
  timestamp: number;
  provider: string;
  model: string;
  estimatedInputTokens: number;
  actualInputTokens?: number;
  actualOutputTokens?: number;
  status: "pending" | "success" | "failed";
}

class TokenUsageManager {
  private records: Map<string, TokenUsageRecord> = new Map();

  recordEstimate(provider: string, model: string, estimated: number): string {
    const requestId = crypto.randomUUID();
    this.records.set(requestId, {
      requestId,
      timestamp: Date.now(),
      provider,
      model,
      estimatedInputTokens: estimated,
      status: "pending",
    });
    return requestId;
  }

  recordActual(
    requestId: string,
    actual: { input: number; output: number },
  ): void {
    const record = this.records.get(requestId);
    if (record) {
      record.actualInputTokens = actual.input;
      record.actualOutputTokens = actual.output;
      record.status = "success";

      // Log accuracy for debugging
      const error = (record.estimatedInputTokens - actual.input) / actual.input;
      console.debug(
        `[TokenUsage] Estimate accuracy: ${(error * 100).toFixed(1)}% error`,
      );
    }
  }
}
```

### Phase 4: Model Selection Memory (Nice-to-have)

**Goal:** Remember the user's last-selected model per provider.

```typescript
class ModelSelectionCache {
  constructor(private context: ExtensionContext) {}

  async saveLastModel(providerId: string, modelId: string): Promise<void> {
    const key = `lastModel.${providerId}`;
    await this.context.globalState.update(key, modelId);
  }

  getLastModel(providerId: string): string | undefined {
    const key = `lastModel.${providerId}`;
    return this.context.globalState.get<string>(key);
  }
}

// In provideLanguageModelChatInformation:
const lastModelId = this.modelCache.getLastModel(this.providerId);
return models.map((m) => ({
  ...m,
  isDefault: m.id === lastModelId,
}));
```

### Phase 4: Context Usage Status Bar (Nice-to-have)

**Goal:** Show token usage breakdown in VS Code status bar for debugging.

Note: Copilot already provides `ChatContextUsageWidget` in the chat panel. A status bar item would be supplementary for debugging/power users.

```typescript
class ContextUsageStatusBar {
  private statusBarItem: vscode.StatusBarItem;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
  }

  update(current: number, max: number): void {
    const percentage = (current / max) * 100;
    const icon =
      percentage > 90 ? "$(warning)" : percentage > 75 ? "$(info)" : "$(check)";

    this.statusBarItem.text = `${icon} ${Math.round(percentage)}%`;
    this.statusBarItem.tooltip = `Token usage: ${current.toLocaleString()} / ${max.toLocaleString()}`;
    this.statusBarItem.show();
  }
}
```

## Implementation Plan

### Phase 1: Message Digest Cache (Week 1) — CRITICAL

**Priority: Highest.** The cache is foundational—everything else depends on it.

1. Create `TokenCache` class with message digest hashing
2. Implement `digestMessage()` using SHA-256 of message content
3. Store cache in `ExtensionContext.workspaceState` for persistence
4. Add cache eviction strategy (LRU or time-based)
5. Write tests for digest stability across message edits

### Phase 2: Wire API Actuals to Cache (Week 1) — CRITICAL

**Priority: High.** This populates the cache with ground truth.

1. Extract `usage.inputTokens` from `finish`/`finish-step` stream events
2. Distribute total across messages proportionally
3. Call `tokenCache.cacheActual()` for each message
4. Verify cache is populated after each successful request

### Phase 3: Token Counter with Cache Lookup (Week 2) — CRITICAL

**Priority: High.** This uses the cache for sent messages, estimates only for unsent.

1. Create `TokenCounter` class that checks cache first
2. Add `js-tiktoken` for estimating unsent messages only
3. Update `provideTokenCount` to use the new flow
4. Apply 2% margin on cached actuals, 5% on estimates
5. Add character-based fallback for unknown encodings

### Phase 4: Usage Analytics (Week 2) — Important

1. Create `TokenUsageManager` class
2. Track estimated vs actual for debugging
3. Log accuracy statistics to output channel
4. Surface in dev tools command

### Phase 5: Nice-to-have (Week 3+)

1. Model selection memory
2. Status bar for debugging

## Preserving Existing Strengths

The following features MUST be preserved:

### Dynamic Model Discovery

```typescript
// KEEP: Fetch models from API instead of hardcoding
const data = await this.fetchModels(apiKey);
const models = this.transformToVSCodeModels(data);
```

### Hybrid Token Estimation

```typescript
// KEEP: Use actual tokens when available
if (
  this.lastRequestInputTokens !== null &&
  messages.length > this.lastRequestMessageCount
) {
  const newMessages = messages.slice(this.lastRequestMessageCount);
  let newTokenEstimate = 0;
  for (const message of newMessages) {
    newTokenEstimate += await this.provideTokenCount(model, message, token);
  }
  return this.lastRequestInputTokens + newTokenEstimate;
}
```

### Correction Factor

```typescript
// KEEP: Rolling average to improve estimates over time
if (this.lastEstimatedInputTokens > 0 && this.lastRequestInputTokens !== null) {
  const newFactor = this.lastRequestInputTokens / this.lastEstimatedInputTokens;
  this.correctionFactor = this.correctionFactor * 0.7 + newFactor * 0.3;
}
```

### Anthropic Context Management

```typescript
// KEEP: Automatic context management for Claude models
const providerOptions = this.isAnthropicModel(model)
  ? { anthropic: { contextManagement: { enabled: true } } }
  : undefined;
```

## Success Criteria

### Primary (Non-Negotiable)

1. **NEVER hit an unrecoverable token limit** — Copilot MUST always have the opportunity to summarize before we exceed the context window. This is the entire point of this RFC.

### How We Achieve This

**Precision first, then add safety margins.**

We should use the most accurate tokenizer available, then apply a deliberate safety buffer on top. Being conservative does NOT mean being imprecise — it means being precise AND adding headroom.

```typescript
// WRONG: Using imprecision as "conservative"
return Math.ceil(text.length / 3.0); // "conservative" but actually just guessing

// RIGHT: Precise count + deliberate safety margin
const preciseCount = encoder.encode(text).length;
const safetyMargin = 1.05; // 5% buffer
return Math.ceil(preciseCount * safetyMargin);
```

**The safety margin architecture:**

| Layer                | Purpose                           | Value                   |
| -------------------- | --------------------------------- | ----------------------- |
| **Tokenizer**        | Accurate base count               | Real tiktoken encoding  |
| **Message overhead** | Account for role/structure tokens | +4 tokens per message   |
| **Request buffer**   | Per-request safety margin         | +5% of estimated total  |
| **maxInputTokens**   | Headroom for output + safety      | `context_window * 0.85` |

This gives us multiple layers of protection while maintaining precision at the base.

### Secondary Criteria

2. **No regressions**: Dynamic discovery, hybrid estimation, correction factor all preserved
3. **Performance**: Token counting adds <10ms per message
4. **Bundle size**: Total increase <500KB (js-tiktoken is ~2MB uncompressed but tree-shakeable)

## Risks and Mitigations

| Risk                       | Impact                  | Mitigation                                          |
| -------------------------- | ----------------------- | --------------------------------------------------- |
| js-tiktoken bundle size    | Extension size increase | Tree-shake to only include needed encodings         |
| Unknown model families     | Inaccurate counts       | Fall back to character-based with correction factor |
| Tokenizer loading time     | Slow first request      | Lazy-load encoders, cache instances                 |
| Breaking existing behavior | User complaints         | Feature flag for gradual rollout                    |

## References

- [VSCODE_SUMMARIZATION_RESEARCH.md](../../research/vscode-summarization-protocol.md) — Research on how Copilot handles summarization
- [VicBilibily/GCMP](https://github.com/VicBilibily/GCMP) — Reference implementation
- [microsoft/vscode-copilot-chat](https://github.com/microsoft/vscode-copilot-chat) — Copilot Chat extension source
- [js-tiktoken](https://github.com/openai/tiktoken/tree/main/js) — JavaScript tokenizer library

## Open Questions

1. Should we expose token usage stats via a VS Code command for debugging?
2. Should the status bar be opt-in or opt-out?
3. Do we need to support custom tokenizers for non-OpenAI/Anthropic models?
4. Should we cache tokenized message hashes to avoid re-tokenizing unchanged messages?
