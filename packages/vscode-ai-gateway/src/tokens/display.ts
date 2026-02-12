/**
 * Shared token display computation.
 *
 * Centralizes the "which number to show" logic so all display paths
 * (status bar, sidebar, tooltips, diagnostics) use identical computation.
 */

import type { AgentEntry } from "../status-bar.js";

/**
 * Result of computing which token value to display for an agent.
 */
export interface DisplayTokens {
  /** The token count to display */
  value: number;
  /** Whether this is an estimate (true) or anchored to API actuals (false) */
  isEstimate: boolean;
}

/**
 * Compute the token count to display for an agent.
 *
 * Logic:
 * - Streaming with delta: lastActualInputTokens + estimatedDeltaTokens (anchored, not estimate)
 * - Streaming without delta: estimatedInputTokens (full re-estimate, IS estimate)
 * - Streaming with nothing: returns null
 * - Complete/error: lastActualInputTokens (multi-turn) or inputTokens (single turn)
 */
export function getDisplayTokens(agent: AgentEntry): DisplayTokens | null {
  if (agent.status === "streaming") {
    if (agent.estimatedDeltaTokens !== undefined) {
      return {
        value: agent.lastActualInputTokens + agent.estimatedDeltaTokens,
        isEstimate: false,
      };
    }
    if (
      agent.estimatedInputTokens !== undefined &&
      agent.estimatedInputTokens > 0
    ) {
      return {
        value: agent.estimatedInputTokens,
        isEstimate: true,
      };
    }
    return null;
  }

  // Complete or error: use actuals
  const value =
    agent.turnCount > 1 ? agent.lastActualInputTokens : agent.inputTokens;
  return { value, isEstimate: false };
}

/**
 * Format a token count for display.
 *
 * @param count - The token count to format
 * @param options.padded - Whether to pad with figure spaces for fixed-width display (status bar)
 * @returns Formatted string like "52.3k", "1.2M", or "500"
 */
export function formatTokens(
  count: number,
  options?: { padded?: boolean },
): string {
  const padded = options?.padded ?? false;
  // Figure space has the same width as digits in most fonts
  const figureSpace = "\u2007";

  if (count >= 1000000) {
    const formatted = `${(count / 1000000).toFixed(1)}M`;
    if (padded) {
      return formatted.padStart(5, figureSpace);
    }
    return formatted;
  }
  if (count >= 1000) {
    const formatted = `${(count / 1000).toFixed(1)}k`;
    if (padded) {
      return formatted.padStart(6, figureSpace);
    }
    return formatted;
  }
  const formatted = count.toString();
  if (padded) {
    return formatted.padStart(3, figureSpace);
  }
  return formatted;
}
