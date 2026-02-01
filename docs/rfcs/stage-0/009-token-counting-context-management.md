# RFC 009: Token Counting and Context Management

**Status:** ✅ Core Implemented | 🔮 Future Work Planned  
**Priority:** Critical  
**Author:** Copilot  
**Created:** 2026-01-27  
**Updated:** 2026-01-31

**Depends On:** 003 (Streaming Adapter), 006 (Token Estimation), 008 (High-Fidelity Model Mapping)  
**Extended By:** [029 (Hybrid Token Estimator)](./029-hybrid-token-estimator.md) - Proactive calibration & compaction detection

## Summary

Accurate token counting is **critical for Copilot's conversation summarization** to trigger correctly. This RFC covers the implemented token counting infrastructure. 

**Related but distinct concerns:**
- **RFC 029 (Hybrid Token Estimator)** - *Accurate measurement*: How to get reliable token counts, especially around compaction events
- **Smart Context Compaction** (future work below) - *Intelligent reduction*: How to reduce context when needed

## Implementation Status

### Core Token Counting (✅ Implemented)

| Feature                             | Status | Location                                      |
| ----------------------------------- | ------ | --------------------------------------------- |
| `TokenCounter` class                | ✅     | tokens/counter.ts                             |
| `TokenCache` (message digest)       | ✅     | tokens/cache.ts                               |
| `LRUCache` for text (5000 entries)  | ✅     | tokens/lru-cache.ts                           |
| Tool schema counting (GCMP formula) | ✅     | counter.ts                                    |
| System prompt overhead (+28 tokens) | ✅     | counter.ts                                    |
| js-tiktoken integration             | ✅     | Uses `o200k_base` and `cl100k_base` encodings |
| Reactive error learning             | ✅     | provider/error-extraction.ts                  |
| API actuals caching                 | ✅     | Caches ground truth from API responses        |
| Correction factor                   | ✅     | Rolling average improves estimates over time  |

### Hybrid Token Estimator (📋 RFC 029)

See [RFC 029](./029-hybrid-token-estimator.md) for proactive calibration and compaction detection.

### Smart Context Compaction (🔮 Future Work)

See "Future Work" section below.

## Background

### How Copilot Summarization Works

1. **Copilot participant** (not the language model provider) handles all summarization
2. Copilot reads `maxInputTokens` from model metadata to know the context limit
3. Copilot uses `provideTokenCount` to estimate message sizes
4. When approaching the limit, Copilot's `SummarizedConversationHistory` triggers summarization

**Key insight:** Language model providers don't implement summarization—they just need to provide accurate metadata and token counts.

## Detailed Design

### Token Count Sources (Priority Order)

| Source                  | When Used                | Accuracy      | Safety Margin |
| ----------------------- | ------------------------ | ------------- | ------------- |
| **Cached API actuals**  | Already-sent messages    | Ground truth  | 2%            |
| **Tiktoken estimation** | Unsent messages only     | Very accurate | 5%            |
| **Character fallback**  | Unknown encodings (rare) | Rough         | 10%           |

### Tool Schema Token Counting (Critical)

Tool schemas can be 50k+ tokens. The GCMP formula:

```typescript
countToolsTokens(tools): number {
  let numTokens = 16;  // Base overhead for tools array
  for (const tool of tools) {
    numTokens += 8;    // Per-tool structural overhead
    numTokens += this.countText(tool.name);
    numTokens += this.countText(tool.description ?? "");
    numTokens += this.countText(JSON.stringify(tool.inputSchema ?? {}));
  }
  return Math.ceil(numTokens * 1.1);  // 1.1x safety factor
}
```

### System Prompt Overhead

System prompts have 28 tokens of structural overhead for Anthropic SDK wrapping.

### Message Digest Caching

Messages are cached by content digest (SHA-256), not position. This means:

- Edited messages lose their cache entry until next API response
- Identical messages share cached counts
- Cache survives message reordering

### Encoding Selection

| Model Family           | Encoding                           |
| ---------------------- | ---------------------------------- |
| GPT-4o, o1             | `o200k_base`                       |
| GPT-4, GPT-3.5, Claude | `cl100k_base`                      |
| Gemini, Unknown        | `cl100k_base` (best approximation) |

## Future Work: Smart Context Compaction

> _Folded from RFC 010: Smart Context Compaction_

### Problem

VS Code's built-in summarization treats all messages equally, losing important context:

- Code snippets get summarized into prose descriptions
- Error messages and stack traces lose detail
- The user's original intent gets buried
- Tool call/result pairs get separated or mangled

With accurate token counting, we now know exactly how much context we have. We should use it more intelligently.

### Research Questions

1. **Interception point**: Can we intercept and transform messages before VS Code sends them? Or do we need to maintain our own shadow history?
2. **LLM summarization**: Do we call an LLM for summaries, or can we do effective compaction heuristically?
3. **User control**: Should users be able to configure compaction aggressiveness?
4. **Multi-turn coherence**: How do we ensure the model understands that some context is summarized vs. verbatim?

### Potential Strategies

#### Strategy A: Sliding Window + Anchors

```
[System Prompt]
[Original User Request]        ← Always preserved
[Structured Summary]           ← Middle messages compacted
[Recent N messages]            ← Fresh context
```

#### Strategy B: Semantic Chunking

Group messages by semantic purpose:

- **Intent chunks**: User requests and clarifications → preserve verbatim
- **Work chunks**: Tool calls, code generation → extract "what changed"
- **Result chunks**: Outputs, errors → keep errors verbatim, summarize success

#### Strategy C: Fact Extraction

Extract structured facts instead of summarizing prose:

```typescript
interface ExtractedContext {
  files: Map<string, FileState>;
  decisions: Decision[];
  errors: ErrorContext[];
  currentTask: string;
}
```

#### Strategy D: Hybrid Compression

Different compression ratios for different content:

- **Code blocks**: Keep verbatim or not at all (can re-read file)
- **Error messages**: Keep verbatim (critical for debugging)
- **Explanations**: Aggressive summarization OK
- **Tool results**: Extract key facts, discard formatting

### Token Budget Model

```
Total Context = System + History + Current Turn + Response Reserve

History Budget = Total - System - CurrentTurn - Reserve
               = contextWindow - ~2000 - currentTokens - maxOutputTokens

Compaction triggers when: actualHistory > historyBudget * 0.8
Target after compaction: actualHistory ≈ historyBudget * 0.5
```

### Implementation Sketch

```typescript
interface CompactionStrategy {
  shouldCompact(history: Message[], budget: number): boolean;
  compact(history: Message[], budget: number): Promise<Message[]>;
}

class SmartCompactor implements CompactionStrategy {
  constructor(
    private tokenCounter: TokenCounter,
    private llm?: LanguageModel, // optional, for summarization
  ) {}

  shouldCompact(history, budget) {
    const used = this.tokenCounter.countMessages(history);
    return used > budget * 0.8;
  }

  async compact(history, budget) {
    const anchors = this.identifyAnchors(history);
    const middle = this.getMiddleSection(history, anchors);

    if (this.llm) {
      const summary = await this.summarize(middle);
      return [anchors.first, summary, ...anchors.recent];
    } else {
      return this.heuristicCompact(history, budget);
    }
  }
}
```

### Next Steps for Compaction

1. Research VS Code's summarization internals
2. Prototype heuristic compaction (no LLM)
3. Measure baseline conversation length limits
4. Test with real coding sessions

## Success Criteria

### Primary (Non-Negotiable)

**NEVER hit an unrecoverable token limit** — Copilot MUST always have the opportunity to summarize before we exceed the context window.

### Secondary

- No regressions: Dynamic discovery, hybrid estimation, correction factor all preserved
- Performance: Token counting adds <10ms per message
- Bundle size: Total increase <500KB

## References

- [VicBilibily/GCMP](https://github.com/VicBilibily/GCMP) — Reference implementation
- [microsoft/vscode-copilot-chat](https://github.com/microsoft/vscode-copilot-chat) — Copilot Chat extension source
- [js-tiktoken](https://github.com/openai/tiktoken/tree/main/js) — JavaScript tokenizer library# RFC 009: Token Counting and Context Management

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

| Feature                    | Our Implementation | GCMP                             |
| -------------------------- | ------------------ | -------------------------------- |
| **Tokenizer**              | ✅ js-tiktoken     | ✅ @microsoft/tiktokenizer       |
| **Tool schema counting**   | ❌ Missing         | ✅ Formula: 16 + 8/tool + 1.1x   |
| **System prompt overhead** | ❌ Missing         | ✅ 28 token overhead             |
| **LRU text cache**         | ❌ Missing         | ✅ 5000 entries                  |
| **Prompt breakdown**       | ❌ Missing         | ✅ Detailed by category          |
| **Context status bar**     | ❌ None            | ✅ Detailed breakdown            |
| **Model selection memory** | ✅ Implemented     | ✅ Remembers last-selected model |
| **Token usage analytics**  | ✅ Basic tracking  | ✅ Full per-provider/model stats |

However, GCMP lacks features we have:

| Feature                     | Our Implementation         | GCMP                   |
| --------------------------- | -------------------------- | ---------------------- |
| **Dynamic model discovery** | ✅ From API                | ❌ Hardcoded in config |
| **API actuals caching**     | ✅ Ground truth from API   | ❌ Pure estimation     |
| **Correction factor**       | ✅ Rolling average         | ❌ None                |
| **Reactive error learning** | ✅ Parse "too long" errors | ❌ None                |
| **Anthropic context mgmt**  | ✅ Enabled                 | ❌ Not mentioned       |

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

| Source                  | When Used                | Accuracy      | Safety Margin |
| ----------------------- | ------------------------ | ------------- | ------------- |
| **Cached API actuals**  | Already-sent messages    | Ground truth  | 2%            |
| **Tiktoken estimation** | Unsent messages only     | Very accurate | 5%            |
| **Character fallback**  | Unknown encodings (rare) | Rough         | 10%           |

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

### Tool Schema Token Counting (CRITICAL — The 50k Gap)

**This is the root cause of our token underestimation.** Tool schemas (JSON schemas for each tool) can be 50k+ tokens, but we never count them.

GCMP uses this formula:

```typescript
private countToolsTokens(tools?: readonly LanguageModelChatTool[]): number {
    if (!tools || tools.length === 0) return 0;

    let numTokens = 16; // Base overhead for tools array

    for (const tool of tools) {
        numTokens += 8; // Per-tool structural overhead
        numTokens += this.countText(tool.name);
        numTokens += this.countText(tool.description || '');
        numTokens += this.countText(JSON.stringify(tool.inputSchema));
    }

    // 1.1x safety factor (official standard from vscode-copilot-chat)
    return Math.floor(numTokens * 1.1);
}
```

**Formula breakdown:**

- **16 tokens**: Base overhead for the tools array structure
- **8 tokens per tool**: Structural overhead for each tool definition
- **Content**: Tokenize name + description + JSON.stringify(inputSchema)
- **1.1x multiplier**: Safety factor aligned with official VS Code Copilot implementation

**Why this matters:** In a typical Copilot session with 50+ tools, the tool schemas alone can be:

- 50 tools × (8 overhead + ~1000 tokens for schema) × 1.1 = ~55,000 tokens

This is the "missing 50k" that caused our token underestimation.

### System Prompt Overhead

System prompts have additional wrapping overhead when sent to providers like Anthropic:

```typescript
const SYSTEM_PROMPT_OVERHEAD = 28; // Tokens for Anthropic system message wrapping

function countSystemPromptTokens(systemText: string): number {
  const contentTokens = this.countText(systemText);
  return contentTokens + SYSTEM_PROMPT_OVERHEAD;
}
```

The 28-token overhead accounts for:

- Role markers and message structure
- Anthropic-specific system message formatting
- Safety padding for variations between models

### LRU Text Cache (Performance Layer)

Distinct from the **API actuals cache** (which stores ground truth from successful requests), the **LRU text cache** is a performance optimization for the tokenizer itself:

```typescript
class LRUCache<T> {
  private cache = new Map<string, T>();
  constructor(private maxSize: number = 5000) {}

  get(key: string): T | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  put(key: string, value: T): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest (first key)
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }
}

class TokenCounter {
  private textCache = new LRUCache<number>(5000);

  private countText(text: string): number {
    if (!text) return 0;

    const cached = this.textCache.get(text);
    if (cached !== undefined) return cached;

    const count = this.encoder.encode(text).length;
    this.textCache.put(text, count);
    return count;
  }
}
```

**Why this helps:**

- Tool names/descriptions are repeated across requests
- System prompt content is often identical
- Avoids re-tokenizing the same strings repeatedly
- 5000 entries is sufficient for typical conversations

### Prompt Breakdown for Debugging

For observability, we should break down prompts into categories:

```typescript
interface PromptPartTokens {
  systemPrompt: number; // System instructions
  availableTools: number; // Tool schemas
  environment: number; // environment_info, workspace_info
  historyMessages: number; // Previous turns
  currentRound: number; // Current turn messages
  thinking: number; // Reasoning content (if present)
  autoCompressed: number; // VS Code's summarization markers
  total: number; // Sum of all parts
}

function analyzePromptParts(
  messages: LanguageModelChatMessage[],
  options: ProvideLanguageModelChatResponseOptions,
): PromptPartTokens {
  // Break down by category for debugging visibility
  // Detect VS Code markers like "conversation-summary" and "environment_info"
  // ...
}
```

**Detection markers from GCMP:**

- `The following is a compressed version of the preceeding history` — Auto-compressed history
- `<conversation-summary>` — VS Code conversation summary
- `</environment_info>\n<workspace_info>` — Environment information

This breakdown helps diagnose where tokens are being consumed.

### Reactive Error Learning (NEW)

When we receive a "too long" error, we can extract the actual token count and use it for future estimates:

```typescript
// Error: "prompt is too long: 204716 tokens > 200000 maximum"

function extractTokenCountFromError(
  error: unknown,
): { actualTokens: number; maxTokens?: number } | undefined {
  const message = extractErrorMessage(error);
  const match = message.match(/(\d+)\s*tokens?\s*>\s*(\d+)/i);
  if (match) {
    return {
      actualTokens: parseInt(match[1], 10),
      maxTokens: parseInt(match[2], 10),
    };
  }
  return undefined;
}

// After catching error:
if (tokenInfo) {
  this.learnedTokenTotal = tokenInfo.actualTokens;
  this.modelInfoChangeEmitter.fire(); // Trigger VS Code to re-query
}
```

This is a **safety net** — the user sees one error, but subsequent requests will have accurate counts.

### Token Counting Architecture Summary

| Layer                       | Type        | Purpose                          | Source                 |
| --------------------------- | ----------- | -------------------------------- | ---------------------- |
| **API Actuals Cache**       | Cached      | Ground truth for sent messages   | Vercel AI finish chunk |
| **LRU Text Cache**          | Performance | Avoid re-tokenizing same strings | In-memory              |
| **Tool Schema Counting**    | Proactive   | Count tools before sending       | options.tools          |
| **System Prompt Overhead**  | Proactive   | Add 28 token overhead            | First system message   |
| **Tiktoken Estimation**     | Proactive   | Estimate unsent messages         | js-tiktoken            |
| **Reactive Error Learning** | Reactive    | Learn from "too long" errors     | Error message parsing  |
| **Correction Factor**       | Adaptive    | Calibrate estimates over time    | Rolling average        |

### Phase 1: Message Digest Cache Infrastructure (Critical)

**Goal:** Build the caching infrastructure that makes API actuals available for all sent messages, even after edits.

This is the highest priority because:

- API actuals are ground truth — no estimation error
- Most messages in a conversation are already-sent
- The cache survives message edits (digest is content-based, not position-based)

### Phase 2: Token Counting with Cache Lookup + Tool Schemas (Critical)

**Goal:** Use cached actuals when available, estimate only unsent messages, AND count tool schemas + system prompt overhead.

1. **Check cache first** — If we have an actual for this message digest, use it
2. **Estimate if needed** — Only for messages without cached actuals (new/edited)
3. **Count tool schemas** — 16 + 8/tool + content tokens, × 1.1 safety factor
4. **Add system prompt overhead** — +28 tokens for Anthropic wrapping
5. **Apply appropriate margin** — 2% on actuals, 5% on estimates

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

### Phase 3: LRU Text Cache + Prompt Breakdown (Important)

**Goal:** Add performance layer and debugging visibility.

1. **LRU Text Cache** — 5000-entry cache for tokenized strings
2. **Prompt Breakdown** — Categorize tokens by type (system, tools, messages, etc.)
3. **Logging** — Output category breakdown for debugging

### Phase 4: Wiring API Actuals to Cache (Critical)

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

### Phase 5: Token Usage Analytics (Important)

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

### Phase 6: Model Selection Memory (Already Implemented)

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

### Phase 7: Context Usage Status Bar (Nice-to-have)

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

### Phase 1: Tool Schema + System Prompt Counting (Week 1) — CRITICAL

**Priority: Highest.** This closes the 50k token gap.

1. Add `countToolsTokens()` to TokenCounter with GCMP formula
2. Add system prompt overhead (28 tokens) calculation
3. Update `estimateTotalInputTokens()` to include tools + system prompt
4. Write tests for tool schema token counting

### Phase 2: Message Digest Cache (Week 1) — DONE ✅

**Already implemented.** The cache is foundational.

1. ✅ `TokenCache` class with message digest hashing
2. ✅ `digestMessage()` using SHA-256 of message content
3. ✅ Store cache in memory (workspace state optional)
4. ✅ Cache eviction strategy (LRU)
5. ✅ Tests for digest stability

### Phase 3: Wire API Actuals to Cache (Week 1) — DONE ✅

**Already implemented.** Populates the cache with ground truth.

1. ✅ Extract `usage.inputTokens` from `finish` stream events
2. ✅ Distribute total across messages proportionally
3. ✅ Call `tokenCache.cacheActual()` for each message
4. ✅ Cache is populated after each successful request

### Phase 4: LRU Text Cache (Week 2) — Important

**Priority: Medium.** Performance optimization.

1. Add 5000-entry LRU cache for tokenized text strings
2. Wrap `encoder.encode()` with cache lookup
3. Measure performance improvement

### Phase 5: Prompt Breakdown for Debugging (Week 2) — Nice-to-have

1. Create `PromptAnalyzer` class
2. Detect VS Code markers (conversation-summary, environment_info)
3. Log breakdown by category
4. Optional: Surface in status bar

### Phase 6: Reactive Error Learning (Week 1) — DONE ✅

**Already implemented.** Safety net for estimation failures.

1. ✅ `extractTokenCountFromError()` parses "too long" errors
2. ✅ Store learned token count
3. ✅ Fire `modelInfoChangeEmitter` to trigger re-evaluation
4. ✅ Clear learned state on successful request

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
4. ~~Should we cache tokenized message hashes to avoid re-tokenizing unchanged messages?~~ **ANSWERED:** Yes, use 5000-entry LRU cache (per GCMP).
5. Should we use `@microsoft/tiktokenizer` instead of `js-tiktoken`? (GCMP uses the former)
6. How should we handle the prompt breakdown logging—debug only, or surface to users?
