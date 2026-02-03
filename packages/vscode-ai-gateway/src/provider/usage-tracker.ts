/**
 * Usage Tracker
 *
 * Tracks token usage from OpenResponses API responses.
 * Provides accurate token counts for VS Code's summarization system.
 */

import type {
  InputTokensDetails,
  OutputTokensDetails,
  Usage,
} from "openresponses-client";

/**
 * Token usage for a single request
 */
export interface TokenUsage {
  /** Number of input tokens used */
  inputTokens: number;
  /** Number of output tokens generated */
  outputTokens: number;
  /** Total tokens (input + output) */
  totalTokens: number;
  /** Cached input tokens (if available) */
  cachedTokens?: number | undefined;
  /** Reasoning tokens (if available) */
  reasoningTokens?: number | undefined;
}

/**
 * Usage tracker that maintains per-request statistics
 */
export class UsageTracker {
  /** Usage by request/chat ID */
  private requestUsage = new Map<string, TokenUsage>();

  /** Listeners for usage updates */
  private listeners = new Set<(usage: TokenUsage, requestId: string) => void>();

  /**
   * Record usage from an OpenResponses API response.
   *
   * @param requestId - Unique identifier for the request
   * @param usage - Usage data from OpenResponses
   */
  record(requestId: string, usage: Usage): TokenUsage {
    const inputDetails = usage.input_tokens_details as
      | InputTokensDetails
      | undefined;
    const outputDetails = usage.output_tokens_details as
      | OutputTokensDetails
      | undefined;

    const tokenUsage: TokenUsage = {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.total_tokens,
      cachedTokens: inputDetails?.cached_tokens,
      reasoningTokens: outputDetails?.reasoning_tokens,
    };

    // Store per-request usage
    this.requestUsage.set(requestId, tokenUsage);

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(tokenUsage, requestId);
      } catch {
        // Ignore listener errors
      }
    }

    return tokenUsage;
  }

  /**
   * Get usage for a specific request.
   *
   * @param requestId - Request identifier
   * @returns Usage data or undefined if not found
   */
  getUsage(requestId: string): TokenUsage | undefined {
    return this.requestUsage.get(requestId);
  }

  /**
   * Get the last recorded usage (most recent request).
   */
  getLastUsage(): TokenUsage | undefined {
    const entries = Array.from(this.requestUsage.entries());
    const lastEntry = entries.at(-1);
    if (!lastEntry) return undefined;
    return lastEntry[1];
  }

  /**
   * Add a listener for usage updates.
   *
   * @param listener - Callback when new usage is recorded
   * @returns Dispose function to remove the listener
   */
  onUsage(
    listener: (usage: TokenUsage, requestId: string) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Clear all tracked usage data.
   */
  clear(): void {
    this.requestUsage.clear();
  }

  /**
   * Format usage for display (e.g., status bar).
   *
   * @param usage - Token usage to format
   * @param options - Formatting options
   */
  static format(
    usage: TokenUsage,
    options: { showOutput?: boolean; compact?: boolean } = {},
  ): string {
    const { showOutput = false, compact = false } = options;

    if (compact) {
      if (showOutput) {
        return `${formatNumber(usage.inputTokens)}/${formatNumber(usage.outputTokens)}`;
      }
      return formatNumber(usage.inputTokens);
    }

    if (showOutput) {
      return `${formatNumber(usage.inputTokens)} in / ${formatNumber(usage.outputTokens)} out`;
    }
    return `${formatNumber(usage.inputTokens)} tokens`;
  }
}

/**
 * Format a number with locale separators and optional abbreviation.
 */
function formatNumber(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 10_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return n.toLocaleString();
}

/**
 * Create a new usage tracker instance.
 */
export function createUsageTracker(): UsageTracker {
  return new UsageTracker();
}
