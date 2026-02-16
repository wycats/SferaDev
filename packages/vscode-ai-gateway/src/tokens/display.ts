/**
 * Shared token display computation.
 *
 * Centralizes the "which number to show" logic so all display paths
 * (status bar, sidebar, tooltips, diagnostics) use identical computation.
 */

import type { AgentEntry } from "../agent/index.js";

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
 * @returns Formatted string like "52.3k", "1.2M", or "500"
 */
export function formatTokens(count: number): string {
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return count.toString();
}
