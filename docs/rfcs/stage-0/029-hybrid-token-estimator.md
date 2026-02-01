# RFC 029: Hybrid Token Estimator

**Status:** Draft  
**Priority:** High  
**Author:** Copilot  
**Created:** 2026-01-31

**Depends On:** 009 (Token Counting - provides foundation)  
**Enables:** 009's Future Work (Smart Context Compaction - needs accurate counts)

## Summary

Replace the current reactive token counting approach with a proactive `HybridTokenEstimator` that provides accurate, confidence-aware token estimates through per-model calibration and call sequence tracking.

## Motivation

### Current Problems

1. **Reactive Learning Only**
   - We only learn actual token counts from "input too long" errors
   - The `learnedTokenTotal` hack inflates counts by 1.5x to trigger summarization
   - This is imprecise and causes unnecessary summarization

2. **Cache Staleness After Compaction**
   - When VS Code compacts/summarizes messages, cached token counts become invalid
   - Compacted messages are "new" with no cache, falling back to tiktoken estimation
   - No way to detect that compaction happened

3. **No Per-Model Calibration**
   - Different models (Claude, GPT-4, Gemini) have different tokenization
   - We use `cl100k_base` as fallback for unknown models
   - Single global `correctionFactor` doesn't account for model differences

4. **Fixed Safety Margins**
   - We apply fixed margins (2%, 5%, 10%) regardless of estimate confidence
   - No feedback loop to adjust margins based on calibration quality

### Key Insight: Call Pattern Tracking

Copilot calls `provideTokenCount` for **every chunk** during prompt rendering:

```javascript
// From Copilot's VSCodeTokenizer
async tokenLength(e, n) {
  return e.type === Text ? this.countTokens(e.text, n) : 0
}
```

This means:
- We're called **many times per request** (once per message/chunk)
- We can track the **sequence of calls** to detect patterns
- We can detect compaction by noticing **message content changes** without needing a VS Code API

## Detailed Design

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     HybridTokenEstimator                        │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │ CallSequence    │  │ Calibration     │  │ Compaction      │ │
│  │ Tracker         │  │ Manager         │  │ Detector        │ │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘ │
│           │                    │                    │          │
│           └────────────────────┼────────────────────┘          │
│                                │                               │
│                    ┌───────────▼───────────┐                   │
│                    │   TokenEstimate       │                   │
│                    │   { tokens, confidence,│                   │
│                    │     source, margin }  │                   │
│                    └───────────────────────┘                   │
└─────────────────────────────────────────────────────────────────┘
```

### Core Interfaces

```typescript
interface TokenEstimate {
  tokens: number;
  confidence: "high" | "medium" | "low";
  source: "api-actual" | "calibrated" | "tiktoken" | "fallback";
  margin: number; // Recommended safety margin based on confidence
}

interface CalibrationState {
  modelFamily: string;
  correctionFactor: number;  // EMA of actual/estimated ratios
  sampleCount: number;
  lastCalibrated: number;
  drift: number;             // Recent deviation from predictions
}

interface CallSequence {
  startTime: number;
  calls: Array<{
    hash: string;
    estimatedTokens: number;
    source: TokenEstimate["source"];
  }>;
  totalEstimate: number;
}
```

### Call Sequence Tracking

Track `provideTokenCount` calls to detect patterns:

```typescript
class CallSequenceTracker {
  private currentSequence: CallSequence | null = null;
  private previousSequence: CallSequence | null = null;
  private knownHashes = new LRUCache<string, number>(10000);
  
  // Gap threshold to detect new sequence (ms)
  // 500ms is forgiving for slow renders with large tool schemas
  private readonly SEQUENCE_GAP = 500;

  onCall(hash: string, estimate: TokenEstimate): void {
    const now = Date.now();
    
    // New sequence if gap > threshold
    if (!this.currentSequence || 
        now - this.currentSequence.startTime > this.SEQUENCE_GAP) {
      this.previousSequence = this.currentSequence;
      this.currentSequence = {
        startTime: now,
        calls: [],
        totalEstimate: 0,
      };
    }
    
    this.currentSequence.calls.push({
      hash,
      estimatedTokens: estimate.tokens,
      source: estimate.source,
    });
    this.currentSequence.totalEstimate += estimate.tokens;
    this.knownHashes.put(hash, estimate.tokens);
  }

  getCurrentSequence(): CallSequence | null {
    return this.currentSequence;
  }

  getPreviousSequence(): CallSequence | null {
    return this.previousSequence;
  }

  isKnownHash(hash: string): boolean {
    return this.knownHashes.get(hash) !== undefined;
  }
}
```

### Compaction Detection

Detect when VS Code has compacted/summarized the conversation:

```typescript
class CompactionDetector {
  constructor(private tracker: CallSequenceTracker) {}

  detectCompaction(currentHash: string): boolean {
    const current = this.tracker.getCurrentSequence();
    const previous = this.tracker.getPreviousSequence();
    
    // Need both sequences with meaningful data to detect compaction
    // This prevents false positives on new conversations or first messages
    if (!current || !previous || previous.calls.length < 3) return false;
    
    // Heuristic 1: New hash we've never seen
    const isNewHash = !this.tracker.isKnownHash(currentHash);
    
    // Heuristic 2: Sequence is significantly shorter than previous
    const isShorter = current.calls.length < previous.calls.length * 0.8;
    
    // Heuristic 3: Total tokens decreased significantly
    const tokensDecreased = current.totalEstimate < previous.totalEstimate * 0.7;
    
    // Compaction likely if: new content AND (shorter OR fewer tokens)
    return isNewHash && (isShorter || tokensDecreased);
  }

  onCompactionDetected(): void {
    // Clear stale cached actuals - they're for pre-compaction messages
    // The calibration state (correction factors) remains valid
    logger.info("Compaction detected - clearing message-level caches");
  }
}
```

### Calibration Manager

Maintain per-model calibration from API actuals:

```typescript
class CalibrationManager {
  private calibrations = new Map<string, CalibrationState>();
  private readonly LEARNING_RATE = 0.2; // EMA alpha
  
  constructor(private context: ExtensionContext) {
    this.loadPersistedState();
  }

  calibrate(
    modelFamily: string,
    estimatedTokens: number,
    actualTokens: number,
  ): void {
    const state = this.calibrations.get(modelFamily) ?? this.defaultState(modelFamily);
    
    // Calculate observed ratio
    const observedRatio = actualTokens / estimatedTokens;
    
    // Update correction factor using exponential moving average
    state.correctionFactor = 
      this.LEARNING_RATE * observedRatio + 
      (1 - this.LEARNING_RATE) * state.correctionFactor;
    
    // Track drift (how far off we were)
    state.drift = Math.abs(1 - observedRatio);
    state.sampleCount++;
    state.lastCalibrated = Date.now();
    
    this.calibrations.set(modelFamily, state);
    this.persistState();
    
    logger.debug(
      `Calibrated ${modelFamily}: factor=${state.correctionFactor.toFixed(3)}, ` +
      `drift=${(state.drift * 100).toFixed(1)}%, samples=${state.sampleCount}`
    );
  }

  getCalibration(modelFamily: string): CalibrationState | undefined {
    return this.calibrations.get(modelFamily);
  }

  getConfidence(modelFamily: string): "high" | "medium" | "low" {
    const state = this.calibrations.get(modelFamily);
    if (!state) return "low";
    
    // High confidence: many samples, low drift
    if (state.sampleCount > 10 && state.drift < 0.1) return "high";
    
    // Medium confidence: some samples
    if (state.sampleCount > 3) return "medium";
    
    return "low";
  }

  private defaultState(modelFamily: string): CalibrationState {
    return {
      modelFamily,
      correctionFactor: 1.0,
      sampleCount: 0,
      lastCalibrated: 0,
      drift: 0,
    };
  }

  private loadPersistedState(): void {
    const persisted = this.context.globalState.get<CalibrationState[]>(
      "tokenEstimator.calibrations"
    );
    if (persisted) {
      for (const state of persisted) {
        this.calibrations.set(state.modelFamily, state);
      }
      logger.debug(`Loaded ${persisted.length} calibration states`);
    }
  }

  private persistState(): void {
    const states = Array.from(this.calibrations.values());
    void this.context.globalState.update("tokenEstimator.calibrations", states);
  }
}
```

### HybridTokenEstimator (Main Class)

```typescript
export class HybridTokenEstimator {
  private sequenceTracker: CallSequenceTracker;
  private compactionDetector: CompactionDetector;
  private calibrationManager: CalibrationManager;
  private tokenCounter: TokenCounter;
  private tokenCache: TokenCache;

  constructor(context: ExtensionContext) {
    this.sequenceTracker = new CallSequenceTracker();
    this.compactionDetector = new CompactionDetector(this.sequenceTracker);
    this.calibrationManager = new CalibrationManager(context);
    this.tokenCounter = new TokenCounter();
    this.tokenCache = new TokenCache();
  }

  /**
   * Estimate tokens for content with confidence.
   * Called by provideTokenCount.
   */
  estimate(
    content: string | LanguageModelChatMessage,
    model: LanguageModelChatInformation,
  ): TokenEstimate {
    const hash = this.hashContent(content);
    
    // Check for compaction
    if (this.compactionDetector.detectCompaction(hash)) {
      this.compactionDetector.onCompactionDetected();
      this.tokenCache.clear(); // Invalidate stale caches
    }
    
    // Try cached API actual first (ground truth)
    if (typeof content !== "string") {
      const cached = this.tokenCache.getCached(content, model.family);
      if (cached !== undefined) {
        const estimate: TokenEstimate = {
          tokens: cached,
          confidence: "high",
          source: "api-actual",
          margin: 0.02,
        };
        this.sequenceTracker.onCall(hash, estimate);
        return estimate;
      }
    }
    
    // Use tiktoken with calibration
    const rawEstimate = typeof content === "string"
      ? this.tokenCounter.estimateTextTokens(content, model.family)
      : this.tokenCounter.estimateMessageTokens(content, model.family);
    
    const calibration = this.calibrationManager.getCalibration(model.family);
    const calibratedTokens = Math.ceil(
      rawEstimate * (calibration?.correctionFactor ?? 1.0)
    );
    
    const confidence = this.calibrationManager.getConfidence(model.family);
    const margin = this.getMarginForConfidence(confidence);
    
    const estimate: TokenEstimate = {
      tokens: calibratedTokens,
      confidence,
      source: calibration ? "calibrated" : "tiktoken",
      margin,
    };
    
    this.sequenceTracker.onCall(hash, estimate);
    return estimate;
  }

  /**
   * Calibrate from API response.
   * Called after successful chat response with usage data.
   */
  calibrate(
    model: LanguageModelChatInformation,
    actualInputTokens: number,
  ): void {
    const sequence = this.sequenceTracker.getCurrentSequence();
    if (!sequence || sequence.totalEstimate === 0) {
      logger.warn("Cannot calibrate: no current sequence");
      return;
    }
    
    this.calibrationManager.calibrate(
      model.family,
      sequence.totalEstimate,
      actualInputTokens,
    );
  }

  /**
   * Get effective token limit based on confidence.
   */
  getEffectiveLimit(
    model: LanguageModelChatInformation,
  ): { limit: number; confidence: "high" | "medium" | "low" } {
    const confidence = this.calibrationManager.getConfidence(model.family);
    const multipliers = {
      high: 0.95,   // Use 95% of limit
      medium: 0.85, // Use 85% of limit
      low: 0.75,    // Use 75% of limit (conservative)
    };
    
    return {
      limit: Math.floor(model.maxInputTokens * multipliers[confidence]),
      confidence,
    };
  }

  /**
   * Get calibration state for debugging/status bar.
   */
  getCalibrationState(modelFamily: string): CalibrationState | undefined {
    return this.calibrationManager.getCalibration(modelFamily);
  }

  private getMarginForConfidence(confidence: "high" | "medium" | "low"): number {
    switch (confidence) {
      case "high": return 0.05;   // 5% margin
      case "medium": return 0.10; // 10% margin
      case "low": return 0.15;    // 15% margin
    }
  }

  private hashContent(content: string | LanguageModelChatMessage): string {
    if (typeof content === "string") {
      return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
    }
    return this.tokenCache.digestMessage(content).slice(0, 16);
  }
}
```

### Integration with Provider

```typescript
// In VercelAIChatModelProvider

private estimator: HybridTokenEstimator;

constructor(context: ExtensionContext) {
  this.estimator = new HybridTokenEstimator(context);
  // ... rest of constructor
}

/**
 * Called by Copilot to get token counts for budget enforcement.
 * Returns RAW calibrated estimate - Copilot applies its own margins.
 * We apply margins only for our internal validation (pre-flight checks).
 */
provideTokenCount(
  model: LanguageModelChatInformation,
  text: string | LanguageModelChatMessage,
  _token: CancellationToken,
): Promise<number> {
  const estimate = this.estimator.estimate(text, model);
  
  // Return raw calibrated estimate - let Copilot apply its own margins
  // Inflating here would cause premature summarization
  logger.trace(
    `Token estimate: ${estimate.tokens} (${estimate.source}, ` +
    `${estimate.confidence} confidence)`
  );
  
  return Promise.resolve(estimate.tokens);
}

/**
 * For our internal pre-flight validation, we DO apply margins.
 */
private async validateBeforeRequest(
  model: LanguageModelChatInformation,
  messages: readonly LanguageModelChatMessage[],
): Promise<{ safe: boolean; estimatedTokens: number }> {
  let total = 0;
  let worstMargin = 0;
  
  for (const msg of messages) {
    const estimate = this.estimator.estimate(msg, model);
    total += estimate.tokens;
    worstMargin = Math.max(worstMargin, estimate.margin);
  }
  
  const withMargin = Math.ceil(total * (1 + worstMargin));
  const effectiveLimit = this.estimator.getEffectiveLimit(model);
  
  return {
    safe: withMargin <= effectiveLimit.limit,
    estimatedTokens: withMargin,
  };
}

// Calibration: extract usage from OpenResponses stream events
// The usage comes from the response.completed event in stream-adapter.ts:
//   case "response.completed":
//     const usage = response.usage; // { input_tokens, output_tokens, total_tokens }
//
// In openresponses-chat.ts, after stream completes:
if (adaptedEvent.done && adaptedEvent.usage?.input_tokens) {
  this.estimator.calibrate(model, adaptedEvent.usage.input_tokens);
}
```

## Implementation Plan

### Phase 1: Core Infrastructure (P0)
- [ ] `CallSequenceTracker` class
- [ ] `CalibrationManager` class with persistence
- [ ] `HybridTokenEstimator` main class
- [ ] Integration with `provideTokenCount`

### Phase 2: Compaction Detection (P0)
- [ ] `CompactionDetector` class
- [ ] Cache invalidation on compaction
- [ ] Logging for debugging

### Phase 3: Calibration Integration (P1)
- [ ] Extract `usage.input_tokens` from `response.completed` event in stream-adapter
- [ ] Pass usage to `openresponses-chat.ts` completion handler
- [ ] Call `calibrate()` after successful requests
- [ ] Status bar display of calibration state
- [ ] Integration test verifying calibration is called with correct values

### Phase 4: Testing & Tuning (P1)
- [ ] Unit tests for each component
- [ ] Integration tests with mock sequences
- [ ] Tune thresholds (sequence gap, compaction detection)
- [ ] Real-world testing with long conversations

## Success Criteria

### Primary
- **No "input too long" errors** that could have been prevented by accurate estimation
- **Calibration converges** within 5-10 requests per model family
- **Compaction detected** reliably (>90% of actual compaction events)

### Secondary
- **Reduced unnecessary summarization** - accurate counts mean VS Code only summarizes when truly needed
- **Transparent confidence** - users/developers can see estimate quality
- **Persistent learning** - calibration survives extension restarts

## Scope

This RFC covers **message token estimation** only. Tool schema tokens are handled separately:
- Tool schemas are passed to `sendRequest`, not through `provideTokenCount`
- Tool schemas are relatively static per-session
- The existing GCMP formula (16 + 8/tool + content × 1.1) works well
- Future work could add `estimateTools()` method if needed

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Sequence gap threshold too short/long | Start at 500ms, make configurable, tune empirically |
| Compaction false positives | Require previous sequence ≥3 calls, multiple heuristics must agree |
| New conversation mistaken for compaction | Guard: `previous.calls.length < 3` returns false |
| Margin double-applied (us + Copilot) | Return raw estimate from `provideTokenCount`, apply margin only for internal validation |
| Calibration drift over time | Track drift metric, alert if too high |
| Memory usage from hash tracking | LRU cache with bounded size (10k entries) |
| Hash collision (64-bit truncation) | ~0.003% collision chance with 10k entries; acceptable |

## Alternatives Considered

### 1. Wait for VS Code API
VS Code could expose a compaction event or provide ground-truth token counts. However:
- No indication this is planned
- We can solve it ourselves with call tracking

### 2. Always use conservative estimates
Just use large safety margins everywhere. However:
- Causes unnecessary summarization
- Wastes context window capacity
- Poor user experience

### 3. Request-level calibration only
Only calibrate when we have API actuals, don't track sequences. However:
- Can't detect compaction
- Slower convergence
- No confidence tracking

## References

- [RFC 009: Token Counting and Context Management](./009-token-counting-context-management.md) - Foundation
- [js-tiktoken](https://github.com/openai/tiktoken/tree/main/js) - Tokenizer library
- [VicBilibily/GCMP](https://github.com/VicBilibily/GCMP) - Token counting research
