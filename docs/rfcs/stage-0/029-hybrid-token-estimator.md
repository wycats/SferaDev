# RFC 029: Delta-Based Token Estimation

**Status:** Implemented  
**Priority:** High  
**Author:** Copilot  
**Created:** 2026-01-31  
**Updated:** 2026-02-01

**Depends On:** 009 (Token Counting - provides foundation)  
**Enables:** 009's Future Work (Smart Context Compaction - needs accurate counts)

## Summary

Replace the current reactive token counting approach with a delta-based `HybridTokenEstimator` that provides accurate token estimates by tracking known conversation states from API responses.

## Key Insight

After each API response, we receive the **exact total input tokens** for that request. For subsequent requests that extend the same conversation, we only need to estimate the **new messages** - the error is bounded to a single message rather than the entire context.

```
Turn 1: Full tiktoken estimate (no known state)
        → API returns: 50,000 actual tokens
        → Store: {messages: [...], actualTokens: 50000}

Turn 2: Known prefix (50,000) + tiktoken(new message ~500)
        → Estimate: 50,500 tokens (error bounded to ~500 tokens)
        → API returns: 50,800 actual tokens
        → Update stored state
```

## Design Changes

This RFC was significantly simplified from an earlier draft:

**Removed:**

- `CalibrationManager` and EMA-based correction factors
- Per-model calibration persistence
- Confidence levels and effective limit multipliers
- Complex margin calculations

**Rationale:** Calibration is unnecessary because:

1. We have ground truth from API responses
2. Delta estimation bounds error to new messages only
3. Simpler code is easier to maintain and debug

## Motivation

### Current Problems

1. **Reactive Learning Only**
   - We only learn actual token counts from "input too long" errors
   - The `learnedTokenTotal` hack inflates counts by 1.5x to trigger summarization
   - This is imprecise and causes unnecessary summarization

2. **Full Context Estimation**
   - Every turn re-estimates the entire conversation with tiktoken
   - Estimation error compounds across all messages
   - 100k+ token conversations have significant cumulative error

### Solution: Delta Estimation

Instead of re-estimating everything, we:

1. Store the known actual token count after each API response
2. On the next turn, check if the conversation extends the known state
3. Return `knownTotal + tiktoken(new messages only)`

This bounds estimation error to just the new content.

## Detailed Design

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     HybridTokenEstimator                        │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────┐  ┌─────────────────┐                  │
│  │ ConversationState   │  │ TokenCounter    │                  │
│  │ Tracker             │  │ (tiktoken)      │                  │
│  └──────────┬──────────┘  └────────┬────────┘                  │
│             │                      │                           │
│             └──────────────────────┘                           │
│                        │                                       │
│          ┌─────────────▼─────────────┐                         │
│          │   ConversationEstimate    │                         │
│          │   { tokens, knownTokens,  │                         │
│          │     estimatedTokens,      │                         │
│          │     source }              │                         │
│          └───────────────────────────┘                         │
└─────────────────────────────────────────────────────────────────┘
```

### Core Interfaces

```typescript
interface KnownConversationState {
  /** Ordered hashes of messages in this conversation */
  messageHashes: string[];
  /** Actual total input tokens from API */
  actualTokens: number;
  /** Model family this was measured for */
  modelFamily: string;
  /** When this was recorded */
  timestamp: number;
}

interface ConversationLookupResult {
  /** Whether we found an exact or prefix match */
  type: "exact" | "prefix" | "none";
  /** Known token count (for exact/prefix match) */
  knownTokens?: number;
  /** Number of new messages beyond the known prefix */
  newMessageCount?: number;
  /** Indices of new messages (for prefix match) */
  newMessageIndices?: number[];
}

interface ConversationEstimate {
  /** Total estimated tokens */
  tokens: number;
  /** How much is from known actual values */
  knownTokens: number;
  /** How much is from tiktoken estimation */
  estimatedTokens: number;
  /** Number of new messages being estimated */
  newMessageCount: number;
  /** Source of the estimate */
  source: "exact" | "delta" | "estimated";
}
```

### ConversationStateTracker

Tracks known conversation states from API responses:

```typescript
class ConversationStateTracker {
  /** Most recent known state per model family */
  private knownStates = new Map<string, KnownConversationState>();

  /**
   * Record actual token count from an API response.
   */
  recordActual(
    messages: readonly LanguageModelChatMessage[],
    modelFamily: string,
    actualTokens: number,
  ): void {
    const messageHashes = messages.map((m) => this.hashMessage(m));
    this.knownStates.set(modelFamily, {
      messageHashes,
      actualTokens,
      modelFamily,
      timestamp: Date.now(),
    });
  }

  /**
   * Look up whether we have knowledge about this conversation.
   *
   * Returns:
   * - "exact": Messages exactly match a known state
   * - "prefix": Known state is a prefix of current messages
   * - "none": No matching state found
   */
  lookup(
    messages: readonly LanguageModelChatMessage[],
    modelFamily: string,
  ): ConversationLookupResult {
    const state = this.knownStates.get(modelFamily);
    if (!state) return { type: "none" };

    const currentHashes = messages.map((m) => this.hashMessage(m));

    // Check for exact match
    if (this.arraysEqual(currentHashes, state.messageHashes)) {
      return { type: "exact", knownTokens: state.actualTokens };
    }

    // Check for prefix match
    if (this.isPrefix(state.messageHashes, currentHashes)) {
      const newCount = currentHashes.length - state.messageHashes.length;
      return {
        type: "prefix",
        knownTokens: state.actualTokens,
        newMessageCount: newCount,
        newMessageIndices: Array.from(
          { length: newCount },
          (_, i) => state.messageHashes.length + i,
        ),
      };
    }

    return { type: "none" };
  }
}
```

### HybridTokenEstimator

Main entry point for token estimation:

```typescript
class HybridTokenEstimator {
  private conversationTracker: ConversationStateTracker;
  private tokenCounter: TokenCounter;

  /**
   * Estimate total tokens for a conversation.
   * Uses delta approach: knownTotal + tiktoken(new messages only)
   */
  estimateConversation(
    messages: readonly LanguageModelChatMessage[],
    model: ModelInfo,
  ): ConversationEstimate {
    const lookup = this.conversationTracker.lookup(messages, model.family);

    if (lookup.type === "exact") {
      // Perfect match - return ground truth
      return {
        tokens: lookup.knownTokens,
        knownTokens: lookup.knownTokens,
        estimatedTokens: 0,
        newMessageCount: 0,
        source: "exact",
      };
    }

    if (lookup.type === "prefix") {
      // Delta estimation - known prefix + estimate new messages
      const newMessages = lookup.newMessageIndices.map((i) => messages[i]);
      const estimatedTokens = this.estimateMessagesTokens(newMessages, model);

      return {
        tokens: lookup.knownTokens + estimatedTokens,
        knownTokens: lookup.knownTokens,
        estimatedTokens,
        newMessageCount: newMessages.length,
        source: "delta",
      };
    }

    // No match - estimate everything
    const estimatedTokens = this.estimateMessagesTokens(messages, model);
    return {
      tokens: estimatedTokens,
      knownTokens: 0,
      estimatedTokens,
      newMessageCount: messages.length,
      source: "estimated",
    };
  }

  /**
   * Record actual token count from API response.
   */
  recordActual(
    messages: readonly LanguageModelChatMessage[],
    model: ModelInfo,
    actualTokens: number,
  ): void {
    this.conversationTracker.recordActual(messages, model.family, actualTokens);
  }
}
```

### Integration with Provider

```typescript
// In VercelAIChatModelProvider

private tokenEstimator: HybridTokenEstimator;

/**
 * Record actual token count from API response.
 * Called after successful chat responses.
 */
recordUsage(
  model: LanguageModelChatInformation,
  messages: readonly LanguageModelChatMessage[],
  actualInputTokens: number,
): void {
  this.tokenEstimator.recordActual(messages, model, actualInputTokens);
}

/**
 * Estimate total input tokens using delta approach.
 */
private async estimateTotalInputTokens(
  model: LanguageModelChatInformation,
  messages: readonly LanguageModelChatMessage[],
): Promise<number> {
  const estimate = this.tokenEstimator.estimateConversation(messages, model);

  logger.debug(
    `Message tokens: ${estimate.tokens} (${estimate.source}, ` +
    `${estimate.knownTokens} known + ${estimate.estimatedTokens} est)`
  );

  return estimate.tokens;
}

// In openresponses-chat.ts, after stream completes:
onUsage: (actualInputTokens) => {
  this.recordUsage(model, chatMessages, actualInputTokens);
}
```

## Implementation

### Files Created

- `src/tokens/conversation-state.ts` - ConversationStateTracker
- `src/tokens/conversation-state.test.ts` - Unit tests

### Files Modified

- `src/tokens/hybrid-estimator.ts` - Refactored to use delta approach
- `src/tokens/hybrid-estimator.test.ts` - Updated tests
- `src/provider.ts` - Updated to use new API
- `src/status-bar.ts` - Simplified estimation state display

### Removed

- CalibrationManager and related calibration logic (still exists but unused)
- Confidence levels and effective limit calculations
- Complex margin calculations

## Success Criteria

### Primary

- ✅ **Delta estimation works** - Logs show "delta (X known + Y est)" after first turn
- ✅ **Accurate tracking** - Message counts increase by 2 per turn (user + assistant)
- ✅ **Error bounded** - Estimation error limited to new messages only

### Secondary

- ✅ **Simple implementation** - ~200 lines of new code
- ✅ **No persistence needed** - State is per-session, resets on reload
- ✅ **Easy to debug** - Clear logging shows estimation source

## Example Log Output

```
[2026-02-01T03:22:58.292Z] [INFO] [Estimator] Recorded actual: 102243 tokens for 142 messages (claude-opus)
[2026-02-01T03:23:28.227Z] [INFO] [Estimator] Recorded actual: 102633 tokens for 144 messages (claude-opus)
[2026-02-01T03:24:41.919Z] [INFO] [Estimator] Recorded actual: 103128 tokens for 146 messages (claude-opus)
```

Each turn adds ~2 messages and ~400-500 tokens.

## Scope

This RFC covers **message token estimation** only. Tool schema tokens are handled separately:

- Tool schemas are passed to `sendRequest`, not through `provideTokenCount`
- Tool schemas are relatively static per-session
- The existing formula (16 + 8/tool + content × 1.1) works well

## Risks & Mitigations

| Risk                                         | Mitigation                                                        |
| -------------------------------------------- | ----------------------------------------------------------------- |
| Conversation diverges (regeneration, branch) | Falls back to full tiktoken estimate                              |
| State lost on reload                         | Acceptable - first turn uses tiktoken, subsequent turns use delta |
| Different model families                     | State tracked per model family                                    |

## Alternatives Considered

### 1. Calibration-based approach (original RFC)

Learn correction factors from API responses using EMA. However:

- More complex implementation
- Requires persistence
- Still estimates entire context each turn
- Delta approach is simpler and more accurate

### 2. Per-message caching

Cache actual token counts per message. However:

- API only returns total, not per-message breakdown
- Would need to distribute total proportionally (imprecise)
- Delta approach is simpler

## References

- [RFC 009: Token Counting and Context Management](./009-token-counting-context-management.md) - Foundation
- [js-tiktoken](https://github.com/openai/tiktoken/tree/main/js) - Tokenizer library
