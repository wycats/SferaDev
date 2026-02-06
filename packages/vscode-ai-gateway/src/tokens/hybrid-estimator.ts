/**
 * Hybrid Token Estimator (RFC 029)
 *
 * Main facade that provides accurate token estimates using delta-based estimation.
 *
 * Key insight: After an API response, we know the EXACT token count for that
 * conversation state. For subsequent requests that extend that conversation,
 * we only need to estimate the NEW messages - the error is bounded to a single
 * message rather than the entire context.
 *
 * Estimation strategy:
 * 1. If conversation exactly matches known state → return actual (ground truth)
 * 2. If conversation extends known state → knownTotal + tiktoken(new messages)
 * 3. Otherwise → tiktoken for all messages
 */

import type * as vscode from "vscode";
import { logger } from "../logger";
import { TokenCache } from "./cache";
import {
  ConversationStateTracker,
  type ConversationLookupResult,
  type KnownConversationState,
} from "./conversation-state";
import { TokenCounter } from "./counter";
import { CallSequenceTracker, type CallSequence } from "./sequence-tracker";

/**
 * Model information needed for estimation.
 * Matches the shape of vscode.LanguageModelChatInformation.
 */
export interface ModelInfo {
  family: string;
  maxInputTokens: number;
}

/**
 * Result of conversation-level token estimation.
 */
export interface ConversationEstimate {
  /** Total estimated tokens */
  tokens: number;
  /** How much of the estimate is from known actual values */
  knownTokens: number;
  /** How much of the estimate is from tiktoken estimation */
  estimatedTokens: number;
  /** Number of new messages being estimated */
  newMessageCount: number;
  /** Whether this is fully known (exact match) or partially estimated */
  source: "exact" | "delta" | "estimated";
}

/**
 * Hybrid Token Estimator - main entry point for token estimation.
 *
 * Provides:
 * - Conversation-level delta estimation (known + tiktoken for new messages only)
 * - Per-message tiktoken estimation (fallback)
 * - Call sequence tracking
 * - Persistent conversation state (survives extension restarts)
 */
export class HybridTokenEstimator {
  private conversationTracker: ConversationStateTracker;
  private sequenceTracker: CallSequenceTracker;
  private tokenCounter: TokenCounter;
  private tokenCache: TokenCache;

  constructor(context: vscode.ExtensionContext) {
    // Pass globalState to ConversationStateTracker for persistence
    this.conversationTracker = new ConversationStateTracker(
      context.globalState,
    );
    this.sequenceTracker = new CallSequenceTracker();
    this.tokenCounter = new TokenCounter();
    this.tokenCache = new TokenCache();
  }

  /**
   * Estimate total tokens for a conversation.
   * This is the primary entry point for accurate estimation.
   *
   * Uses delta approach: knownTotal + tiktoken(new messages only)
   */
  estimateConversation(
    messages: readonly vscode.LanguageModelChatMessage[],
    model: ModelInfo,
    conversationId?: string,
  ): ConversationEstimate {
    const lookup = this.conversationTracker.lookup(
      messages,
      model.family,
      conversationId,
    );

    if (lookup.type === "exact" && lookup.knownTokens !== undefined) {
      // Perfect match - return ground truth
      const result: ConversationEstimate = {
        tokens: lookup.knownTokens,
        knownTokens: lookup.knownTokens,
        estimatedTokens: 0,
        newMessageCount: 0,
        source: "exact",
      };
      logger.debug(
        `[Estimator] Exact match: ${result.tokens.toString()} tokens (ground truth)`,
      );
      return result;
    }

    if (
      lookup.type === "prefix" &&
      lookup.knownTokens !== undefined &&
      lookup.newMessageIndices !== undefined
    ) {
      // Delta estimation - known prefix + estimate new messages
      const newMessages = lookup.newMessageIndices.map((i) => {
        const msg = messages[i];
        if (!msg) throw new Error(`Invalid message index: ${i.toString()}`);
        return msg;
      });
      const estimatedTokens = this.estimateMessagesTokens(newMessages, model);

      const result: ConversationEstimate = {
        tokens: lookup.knownTokens + estimatedTokens,
        knownTokens: lookup.knownTokens,
        estimatedTokens,
        newMessageCount: newMessages.length,
        source: "delta",
      };
      logger.debug(
        `[Estimator] Delta: ${lookup.knownTokens.toString()} known + ${estimatedTokens.toString()} est ` +
          `(${newMessages.length.toString()} new messages) = ${result.tokens.toString()} total`,
      );
      return result;
    }

    // No match - estimate everything
    const estimatedTokens = this.estimateMessagesTokens(
      messages as vscode.LanguageModelChatMessage[],
      model,
    );
    const result: ConversationEstimate = {
      tokens: estimatedTokens,
      knownTokens: 0,
      estimatedTokens,
      newMessageCount: messages.length,
      source: "estimated",
    };
    logger.debug(
      `[Estimator] Full estimate: ${estimatedTokens.toString()} tokens ` +
        `(${messages.length.toString()} messages)`,
    );
    return result;
  }

  /**
   * Record actual token count from API response.
   * This enables future delta estimation for extensions of this conversation.
   */
  recordActual(
    messages: readonly vscode.LanguageModelChatMessage[],
    model: ModelInfo,
    actualTokens: number,
    conversationId?: string,
    sequenceEstimate?: number,
    summarizationDetected?: boolean,
  ): void {
    const lookup = this.conversationTracker.lookup(
      messages,
      model.family,
      conversationId,
    );

    if (
      lookup.type === "prefix" &&
      lookup.knownTokens !== undefined &&
      lookup.newMessageIndices !== undefined
    ) {
      const delta = actualTokens - lookup.knownTokens;
      const newMessageCount = lookup.newMessageIndices.length;

      if (delta > 0 && newMessageCount > 0) {
        const perMessageTokens = Math.round(delta / newMessageCount);
        logger.debug(
          `[Estimator] Delta caching opportunity: ${delta.toString()} tokens / ${newMessageCount.toString()} messages = ${perMessageTokens.toString()} per message`,
        );
        for (const index of lookup.newMessageIndices) {
          const message = messages[index];
          if (message) {
            this.tokenCache.cacheActual(message, model.family, perMessageTokens);
          } else {
            logger.warn(
              `[Estimator] Invalid message index ${index.toString()} during delta caching`,
            );
          }
        }
      } else if (delta < 0) {
        logger.warn(
          `[Estimator] Negative delta detected: ${delta.toString()} tokens (actual=${actualTokens.toString()}, known=${lookup.knownTokens.toString()})`,
        );
      }
    }

    this.conversationTracker.recordActual(
      messages,
      model.family,
      actualTokens,
      conversationId,
      sequenceEstimate,
      summarizationDetected,
    );
    logger.info(
      `[Estimator] Recorded actual: ${actualTokens.toString()} tokens for ` +
        `${messages.length.toString()} messages (${model.family})`,
    );
  }

  /**
   * Estimate tokens for a single message.
   * Used by provideTokenCount for per-message estimation.
   */
  estimateMessage(
    content: string | vscode.LanguageModelChatMessage,
    model: ModelInfo,
    conversationId?: string,
  ): number {
    // CRITICAL: Check if this is first message BEFORE any onCall()
    // wouldStartNewSequence() checks the same condition as onCall() without side effects
    const isFirstInSequence = this.sequenceTracker.wouldStartNewSequence();

    // Try cached API actual first (ground truth)
    if (typeof content !== "string") {
      const cached = this.tokenCache.getCached(content, model.family);
      if (cached !== undefined) {
        this.sequenceTracker.onCall({
          tokens: cached,
          confidence: "high",
          source: "api-actual",
          margin: 0.02,
        });
        return cached;
      }
    }

    // Use tiktoken
    const estimate =
      typeof content === "string"
        ? this.tokenCounter.estimateTextTokens(content, model.family)
        : this.tokenCounter.estimateMessageTokens(content, model.family);

    // Apply rolling correction to first message of each turn (RFC 047)
    let finalEstimate = estimate;
    if (isFirstInSequence) {
      const adjustment = this.getAdjustment(model.family, conversationId);
      if (adjustment > 0) {
        finalEstimate = estimate + adjustment;
        logger.debug(
          `[Estimator] Rolling correction: ${estimate.toString()} + ${adjustment.toString()} = ${finalEstimate.toString()}`,
        );
      }
    }

    this.sequenceTracker.onCall({
      tokens: finalEstimate,
      confidence: "low",
      source: "tiktoken",
      margin: 0.15,
    });

    return finalEstimate;
  }

  /**
   * Estimate total tokens for a list of messages using tiktoken.
   */
  private estimateMessagesTokens(
    messages: readonly vscode.LanguageModelChatMessage[],
    model: ModelInfo,
  ): number {
    let total = 0;
    for (const message of messages) {
      total += this.estimateMessage(message, model);
    }
    // Add message structure overhead (~4 tokens per message)
    total += messages.length * 4;
    return total;
  }

  /**
   * Get conversation state for status bar display.
   */
  getConversationState(
    modelFamily: string,
    conversationId?: string,
  ): KnownConversationState | undefined {
    return this.conversationTracker.getState(modelFamily, conversationId);
  }

  /**
   * Get the correction adjustment for the current conversation.
   * Returns 0 if no prior state or if this is the first turn.
   *
   * The adjustment is: actualTokens - lastSequenceEstimate
   * This represents the error between what VS Code saw (sum of provideTokenCount)
   * and what the API actually reported.
   */
  getAdjustment(modelFamily: string, conversationId?: string): number {
    const state = this.conversationTracker.getState(
      modelFamily,
      conversationId,
    );
    if (!state || state.lastSequenceEstimate === undefined) {
      return 0;
    }
    return Math.max(0, state.actualTokens - state.lastSequenceEstimate);
  }

  /**
   * Look up conversation state for given messages.
   */
  lookupConversation(
    messages: readonly vscode.LanguageModelChatMessage[],
    modelFamily: string,
    conversationId?: string,
  ): ConversationLookupResult {
    return this.conversationTracker.lookup(
      messages,
      modelFamily,
      conversationId,
    );
  }

  /**
   * Get current sequence for tracking.
   */
  getCurrentSequence(): CallSequence | null {
    return this.sequenceTracker.getCurrentSequence();
  }

  /**
   * Cache actual token count from API response.
   * Used to build ground truth for future estimates.
   */
  cacheActual(
    message: vscode.LanguageModelChatMessage,
    modelFamily: string,
    actualTokens: number,
  ): void {
    this.tokenCache.cacheActual(message, modelFamily, actualTokens);
  }

  /**
   * Get the underlying token counter (for tool schema counting).
   */
  getTokenCounter(): TokenCounter {
    return this.tokenCounter;
  }

  /**
   * Reset for testing.
   */
  reset(): void {
    this.sequenceTracker.reset();
    this.conversationTracker.clear();
  }
}
