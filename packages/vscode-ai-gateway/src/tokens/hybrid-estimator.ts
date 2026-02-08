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
import { ConfigService } from "../config";
import { logger } from "../logger";
import { computeNormalizedDigest } from "../utils/digest";
import { TokenCache } from "./cache";
import {
  ConversationStateTracker,
  type ConversationLookupResult,
  type KnownConversationState,
} from "./conversation-state";
import { TokenCounter } from "./counter";
import { CallSequenceTracker, type CallSequence } from "./sequence-tracker";
import { TokenValidationLogger } from "./validation-logger";

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
export class HybridTokenEstimator implements vscode.Disposable {
  private conversationTracker: ConversationStateTracker;
  private sequenceTracker: CallSequenceTracker;
  private tokenCounter: TokenCounter;
  private tokenCache: TokenCache;
  private validationLogger: TokenValidationLogger | undefined;

  constructor(context: vscode.ExtensionContext, configService?: ConfigService) {
    // Pass globalState to ConversationStateTracker for persistence
    this.conversationTracker = new ConversationStateTracker(
      context.globalState,
    );
    this.sequenceTracker = new CallSequenceTracker();
    this.tokenCounter = new TokenCounter();
    this.tokenCache = new TokenCache(context.globalState);
    if (configService) {
      this.validationLogger = new TokenValidationLogger(configService);
    }
  }

  dispose(): void {
    this.conversationTracker.dispose();
  }

  /**
   * Estimate total tokens for a conversation.
   * This is the primary entry point for accurate estimation.
   *
   * Uses delta approach: knownTotal + tiktoken(new messages only)
   */
  /**
   * Estimate total tokens for a conversation.
   * This is the primary entry point for accurate estimation.
   *
   * Uses delta approach: knownTotal + tiktoken(new messages only)
   *
   * @param options.tools - Tool definitions to include in estimate (for full estimation)
   * @param options.systemPrompt - System prompt to include in estimate
   */
  estimateConversation(
    messages: readonly vscode.LanguageModelChatMessage[],
    model: ModelInfo,
    options?: {
      tools?: readonly {
        name: string;
        description?: string;
        inputSchema?: unknown;
      }[];
      systemPrompt?: string;
    },
  ): ConversationEstimate {
    const lookup = this.conversationTracker.lookup(messages, model.family);

    // Helper to calculate context overhead (tools + system) when needed
    const calculateOverhead = () => {
      let overhead = 0;
      let toolTokens = 0;
      let systemLimitTokens = 0;

      if (options?.tools && options.tools.length > 0) {
        toolTokens = this.tokenCounter.countToolsTokens(
          options.tools,
          model.family,
        );
        overhead += toolTokens;
      }
      if (options?.systemPrompt) {
        systemLimitTokens = this.tokenCounter.countSystemPromptTokens(
          options.systemPrompt,
          model.family,
        );
        overhead += systemLimitTokens;
      }
      return { total: overhead, toolTokens, systemLimitTokens };
    };

    if (lookup.type === "exact" && lookup.knownTokens !== undefined) {
      // Perfect match - return ground truth.
      // NOTE: knownTokens includes tools/system from the previous actual API call.
      // We assume tools/system haven't changed meaningfully since then.
      const result: ConversationEstimate = {
        tokens: lookup.knownTokens,
        knownTokens: lookup.knownTokens,
        estimatedTokens: 0,
        newMessageCount: 0,
        source: "exact",
      };
      this.validationLogger?.log({
        type: "estimate",
        modelFamily: model.family,
        totalTokens: result.tokens,
        knownTokens: result.knownTokens,
        estimatedTokens: 0,
        messageCount: messages.length,
        newMessageCount: 0,
      });
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
      // knownTokens includes tools/system from the prefix point.
      const newMessages = lookup.newMessageIndices.map((i) => {
        const msg = messages[i];
        if (!msg) throw new Error(`Invalid message index: ${i.toString()}`);
        return msg;
      });
      const estimatedMessageTokens = this.estimateMessagesTokens(
        newMessages,
        model,
      );

      // We do NOT add overhead here because knownTokens already has it.
      // (Unless tools changed, but we can't detect that easily here)

      const result: ConversationEstimate = {
        tokens: lookup.knownTokens + estimatedMessageTokens,
        knownTokens: lookup.knownTokens,
        estimatedTokens: estimatedMessageTokens,
        newMessageCount: newMessages.length,
        source: "delta",
      };
      this.validationLogger?.log({
        type: "estimate",
        modelFamily: model.family,
        totalTokens: result.tokens,
        knownTokens: result.knownTokens,
        estimatedTokens: estimatedMessageTokens,
        messageCount: messages.length,
        newMessageCount: result.newMessageCount,
      });
      logger.debug(
        `[Estimator] Delta: ${lookup.knownTokens.toString()} known + ${estimatedMessageTokens.toString()} est ` +
          `(${newMessages.length.toString()} new messages) = ${result.tokens.toString()} total`,
      );
      return result;
    }

    // No match - estimate everything
    const estimatedMessageTokens = this.estimateMessagesTokens(
      messages as vscode.LanguageModelChatMessage[],
      model,
    );

    // For full estimate, we MUST include overhead (tools + system)
    const overhead = calculateOverhead();
    const totalEstimated = estimatedMessageTokens + overhead.total;

    // CAPTURE: Save the inputs to a file for forensic analysis of the undercount
    if (this.validationLogger) {
      this.validationLogger.captureForensic("last-estimation-input.json", {
        timestamp: new Date().toISOString(),
        input: messages.map((m) => ({
          role: m.role,
          content: m.content.map((p) => {
            if ("value" in p) return { type: "text", value: p.value };
            if ("callId" in p && "name" in p)
              return {
                type: "toolCall",
                name: p.name,
                input: (p as any).input,
              };
            if ("callId" in p)
              return { type: "toolResult", content: (p as any).content };
            return { type: "other" };
          }),
        })),
        options,
        estimate: {
          messages: estimatedMessageTokens,
          tools: overhead.toolTokens,
          system: overhead.systemLimitTokens,
          total: totalEstimated,
        },
      });
    }

    const result: ConversationEstimate = {
      tokens: totalEstimated,
      knownTokens: 0,
      estimatedTokens: totalEstimated,
      newMessageCount: messages.length,
      source: "estimated",
    };
    this.validationLogger?.log({
      type: "estimate",
      modelFamily: model.family,
      totalTokens: result.tokens,
      knownTokens: 0,
      estimatedTokens: totalEstimated,
      messageCount: messages.length,
      newMessageCount: result.newMessageCount,
    });
    logger.debug(
      `[Estimator] Full estimate: ${totalEstimated.toString()} tokens ` +
        `(${estimatedMessageTokens.toString()} msg + ${overhead.toolTokens.toString()} tool + ${overhead.systemLimitTokens.toString()} sys) ` +
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
    sequenceEstimate?: number,
    summarizationDetected?: boolean,
    responseMessage?: vscode.LanguageModelChatMessage,
    responseTokens?: number,
  ): void {
    const lookup = this.conversationTracker.lookup(messages, model.family);

    if (
      lookup.type === "prefix" &&
      lookup.knownTokens !== undefined &&
      lookup.newMessageIndices !== undefined
    ) {
      const delta = actualTokens - lookup.knownTokens;
      const newMessageCount = lookup.newMessageIndices.length;

      // Smart Delta Caching:
      // We want to attribute the delta tokens to specific messages to build our fine-grained cache.
      // 1. If we have exactly 1 new message, it gets the full delta.
      // 2. If we have N new messages, and we already know N-1 of them from cache,
      //    we can deduce the last one: Unknown = Delta - Sum(Known).
      // We avoid the "Averaging Heuristic" (Delta / N) as it poisons the cache.

      if (delta > 0 && newMessageCount > 0) {
        const unknownMessages: { index: number; weight: number }[] = [];
        let totalWeight = 0;
        let unknownCount = 0;
        let knownTokensSum = 0;

        for (const index of lookup.newMessageIndices) {
          const message = messages[index];
          if (!message) {
            logger.warn(
              `[Estimator] Invalid message index ${index} during delta caching`,
            );
            continue;
          }

          // Check if this specific message is already in our cache
          const cached = this.tokenCache.getCached(message, model.family);

          if (cached !== undefined) {
            knownTokensSum += cached;
          } else {
            const weight = this.tokenCounter.estimateMessageTokens(
              message,
              model.family,
            );
            unknownMessages.push({ index, weight });
            totalWeight += weight;
            unknownCount++;
          }
        }

        if (unknownCount > 0 && delta > knownTokensSum) {
          const remainingDelta = delta - knownTokensSum;

          for (const item of unknownMessages) {
            const message = messages[item.index]!;
            // Proportional Distribution Rule (Atomic Message Algebra)
            // Weight = Tiktoken(M) / Sum(Tiktoken(Unknowns))
            const ratio =
              totalWeight > 0 ? item.weight / totalWeight : 1 / unknownCount;
            const inferredTokens = Math.max(
              1,
              Math.round(remainingDelta * ratio),
            );

            this.validationLogger?.log({
              type: "deduction",
              modelFamily: model.family,
              deducedTokens: inferredTokens,
              messageRole: String(message.role),
              messageDigest: computeNormalizedDigest(message),
              isProportional: unknownCount > 1,
            });

            logger.debug(
              `[Estimator] Inferred tokens for message via ${unknownCount > 1 ? "proportional distribution" : "deduction"}: ` +
                `${inferredTokens.toString()} (weight=${item.weight.toString()}, totalDelta=${remainingDelta.toString()})`,
            );
            this.tokenCache.cacheActual(message, model.family, inferredTokens);
          }
        } else if (unknownCount > 0) {
          // Ambiguous case: >0 unknown messages but remaining delta is zero/negative.
          logger.warn(
            `[Estimator] Skipped delta caching: ${unknownCount.toString()} unknown messages but ` +
              `remaining delta is ${(delta - knownTokensSum).toString()} (totalDelta=${delta.toString()}, known=${knownTokensSum.toString()}).`,
          );
        }
      } else if (delta < 0) {
        logger.warn(
          `[Estimator] Negative delta detected: ${delta.toString()} tokens (actual=${actualTokens.toString()}, known=${lookup.knownTokens.toString()})`,
        );
        this.validationLogger?.log({
          type: "deduction",
          modelFamily: model.family,
          deducedTokens: delta, // Negative delta
          delta,
        });
      }
    }

    if (responseMessage && typeof responseTokens === "number") {
      this.tokenCache.cacheActual(
        responseMessage,
        model.family,
        responseTokens,
      );
      logger.debug(
        `[Estimator] Cached response message tokens: ${responseTokens.toString()} (${model.family})`,
      );
    }

    this.conversationTracker.recordActual(
      messages,
      model.family,
      actualTokens,
      sequenceEstimate,
      summarizationDetected,
    );
    this.validationLogger?.log({
      type: "actual",
      modelFamily: model.family,
      totalTokens: actualTokens,
      messageCount: messages.length,
    });
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
  ): number {
    // CRITICAL: Check if this is first message BEFORE any onCall()
    // wouldStartNewSequence() checks the same condition as onCall() without side effects
    const isFirstInSequence = this.sequenceTracker.wouldStartNewSequence();
    const adjustment = isFirstInSequence ? this.getAdjustment(model.family) : 0;

    // Try cached API actual first (ground truth)
    if (typeof content !== "string") {
      const cached = this.tokenCache.getCached(content, model.family);
      if (cached !== undefined) {
        const finalEstimate = cached + adjustment;
        if (adjustment > 0) {
          logger.debug(
            `[Estimator] Rolling correction: ${cached.toString()} + ${adjustment.toString()} = ${finalEstimate.toString()}`,
          );
        }
        this.sequenceTracker.onCall({
          tokens: finalEstimate,
          confidence: "high",
          source: "api-actual",
          margin: 0.02,
        });
        return finalEstimate;
      }
    }

    // Use tiktoken
    const estimate =
      typeof content === "string"
        ? this.tokenCounter.estimateTextTokens(content, model.family)
        : this.tokenCounter.estimateMessageTokens(content, model.family);

    // Apply rolling correction to first message of each turn (RFC 047)
    let finalEstimate = estimate;
    if (adjustment > 0) {
      finalEstimate = estimate + adjustment;
      logger.debug(
        `[Estimator] Rolling correction: ${estimate.toString()} + ${adjustment.toString()} = ${finalEstimate.toString()}`,
      );
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
    let cachedCount = 0;
    for (const message of messages) {
      const cached = this.tokenCache.getCached(message, model.family);
      if (cached !== undefined) {
        total += cached;
        cachedCount += 1;
        continue;
      }
      total += this.estimateMessageTokensOnly(message, model);
    }
    // Add message structure overhead (~4 tokens per message)
    total += (messages.length - cachedCount) * 4;
    return total;
  }

  /**
   * Side-effect free estimation for conversation-level totals.
   */
  private estimateMessageTokensOnly(
    message: vscode.LanguageModelChatMessage,
    model: ModelInfo,
  ): number {
    const cached = this.tokenCache.getCached(message, model.family);
    if (cached !== undefined) {
      return cached;
    }
    return this.tokenCounter.estimateMessageTokens(message, model.family);
  }

  /**
   * Get conversation state for status bar display.
   * @deprecated Model-family based lookup is deprecated in favor of exact history.
   */
  getConversationState(
    _modelFamily: string,
  ): KnownConversationState | undefined {
    // Current tracker does not support family-based lookup (latest wins)
    // We return undefined to signal no "global family state" exists.
    return undefined;
  }

  /**
   * Get the correction adjustment for the current conversation.
   * Returns 0 as we now rely on exact history match instead of rolling correction.
   */
  getAdjustment(_modelFamily: string): number {
    return 0;
  }

  /**
   * Look up conversation state for given messages.
   */
  lookupConversation(
    messages: readonly vscode.LanguageModelChatMessage[],
    modelFamily: string,
  ): ConversationLookupResult {
    return this.conversationTracker.lookup(messages, modelFamily);
  }

  /**
   * Get debug info about conversation state for forensic capture.
   */
  getConversationLookupDebug(
    modelFamily: string,
    messages?: readonly vscode.LanguageModelChatMessage[],
  ): {
    hasState: boolean;
    stateSize: number;
    matchType?: string;
  } {
    // Basic debug info
    // Since we can't look up by family, we can only report size or check lookup if messages provided
    let matchType = "none";

    if (messages) {
      const result = this.conversationTracker.lookup(messages, modelFamily);
      matchType = result.type;
    }

    return {
      hasState: this.conversationTracker.size() > 0,
      stateSize: this.conversationTracker.size(),
      matchType,
    };
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
