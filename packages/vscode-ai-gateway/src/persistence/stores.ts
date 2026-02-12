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
  key: "vercel.ai.sessionStats",
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
  // Legacy key from pre-rebrand extension (SferaDev -> Vercel)
  legacyKeys: ["vercelAiGateway.sessionStats"],
};

/**
 * Per-conversation agent state for delta token estimation.
 * Persisted to enable accurate token display across VS Code reloads.
 */
export interface PersistedAgentState {
  /** Actual input tokens from last completed turn (from API response) */
  lastActualInputTokens: number;
  /** Number of messages in last completed request */
  lastMessageCount: number;
  /** Number of completed turns in this conversation */
  turnCount: number;
  /** Model used (for diagnostics) */
  modelId?: string;
  /** Whether VS Code summarization was detected */
  summarizationDetected?: boolean;
  /** Total tokens freed by summarization */
  summarizationReduction?: number;
  /** Timestamp for LRU eviction (named fetchedAt for store.ts compatibility) */
  fetchedAt: number;
}

/**
 * Wrapper for per-conversation agent state store.
 * Keyed by conversationId (stable UUID from stateful marker sessionId).
 */
export interface PersistedAgentStateMap {
  entries: Record<string, PersistedAgentState>;
}

export const AGENT_STATE_STORE: StoreConfig<PersistedAgentStateMap> = {
  key: "vercel.ai.agentState",
  version: 1,
  scope: "global",
  defaultValue: { entries: {} },
  maxEntries: 100,
  ttlMs: 7 * 24 * 60 * 60 * 1000, // 7 days
};
