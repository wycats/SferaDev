/**
 * Call Sequence Tracker for Hybrid Token Estimation (RFC 029)
 *
 * Tracks sequences of provideTokenCount calls to accumulate per-turn totals.
 * Copilot calls provideTokenCount for every chunk during prompt rendering,
 * so we track these calls to know the total estimated tokens for a turn.
 *
 * Key insight: Each turn starts a new sequence (500ms gap between render passes).
 */

import { logger } from "../logger";

/**
 * Source of a token estimate, ordered by reliability.
 */
export type TokenEstimateSource =
  | "api-actual" // Ground truth from API response
  | "calibrated" // Tiktoken adjusted by learned correction factor
  | "tiktoken" // Raw tiktoken estimate
  | "fallback"; // Character-based fallback

/**
 * A single token estimate with confidence metadata.
 */
export interface TokenEstimate {
  /** Estimated token count */
  tokens: number;
  /** Confidence level based on calibration quality */
  confidence: "high" | "medium" | "low";
  /** Source of the estimate */
  source: TokenEstimateSource;
  /** Recommended safety margin based on confidence (0.05 = 5%) */
  margin: number;
}

/**
 * A single call within a sequence.
 */
export interface SequenceCall {
  /** Estimated tokens for this call */
  estimatedTokens: number;
  /** Source of the estimate */
  source: TokenEstimateSource;
}

/**
 * A sequence of provideTokenCount calls representing a single turn.
 */
export interface CallSequence {
  /** When the sequence started */
  startTime: number;
  /** When the last call was made (used for gap detection) */
  lastCallTime: number;
  /** All calls in this sequence */
  calls: SequenceCall[];
  /** Running total of estimated tokens */
  totalEstimate: number;
}

/**
 * Tracks sequences of provideTokenCount calls.
 *
 * Gap detection uses lastCallTime (not startTime) to prevent long renders
 * from being incorrectly split into multiple sequences.
 */
export class CallSequenceTracker {
  private currentSequence: CallSequence | null = null;

  /**
   * Gap threshold to detect new sequence (ms).
   * 500ms is forgiving for slow renders with large tool schemas.
   */
  private readonly SEQUENCE_GAP = 500;

  /**
   * Record a provideTokenCount call.
   * Starts a new sequence if the gap since the last call exceeds threshold.
   */
  onCall(estimate: TokenEstimate): void {
    const now = Date.now();

    // New sequence if gap since LAST CALL > threshold
    // (not since start, otherwise long renders would split incorrectly)
    if (
      !this.currentSequence ||
      now - this.currentSequence.lastCallTime > this.SEQUENCE_GAP
    ) {
      if (this.currentSequence) {
        logger.debug(
          `New sequence started (gap: ${(now - this.currentSequence.lastCallTime).toString()}ms, ` +
            `previous: ${this.currentSequence.calls.length.toString()} calls, ` +
            `${this.currentSequence.totalEstimate.toString()} tokens)`,
        );
      }

      this.currentSequence = {
        startTime: now,
        lastCallTime: now,
        calls: [],
        totalEstimate: 0,
      };
    }

    this.currentSequence.lastCallTime = now;
    this.currentSequence.calls.push({
      estimatedTokens: estimate.tokens,
      source: estimate.source,
    });
    this.currentSequence.totalEstimate += estimate.tokens;

    logger.trace(
      `Sequence call #${this.currentSequence.calls.length.toString()}: ` +
        `+${estimate.tokens.toString()} tokens (${estimate.source}), ` +
        `total: ${this.currentSequence.totalEstimate.toString()}`,
    );
  }

  /**
   * Get the current sequence, if any.
   */
  getCurrentSequence(): CallSequence | null {
    return this.currentSequence;
  }

  /**
   * Reset the tracker (for testing).
   */
  reset(): void {
    this.currentSequence = null;
  }
}
