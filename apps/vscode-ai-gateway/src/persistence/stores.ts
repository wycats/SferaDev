/**
 * Concrete store configurations for the persistence layer.
 */

import type { StoreConfig } from "./types.js";

/**
 * Aggregate session statistics for display on boot.
 */
export interface SessionStats {
  /** When stats were last updated */
  timestamp: number;
  /** Total agents tracked in session */
  agentCount: number;
  /** Main agent turn count */
  mainAgentTurns: number;
  /** Max context size reached (not sum) */
  maxObservedInputTokens: number;
  /** Accumulated output tokens */
  totalOutputTokens: number;
  /** Primary model used */
  modelId: string | null;
}

export const SESSION_STATS_STORE: StoreConfig<SessionStats> = {
  key: "vercelAiGateway.sessionStats",
  version: 1,
  scope: "global",
  defaultValue: {
    timestamp: 0,
    agentCount: 0,
    mainAgentTurns: 0,
    maxObservedInputTokens: 0,
    totalOutputTokens: 0,
    modelId: null,
  },
};
