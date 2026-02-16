/**
 * Agent types extracted from TokenStatusBar for use across the codebase.
 *
 * These types define the core data structures for agent tracking:
 * - AgentEntry: The primary agent state object
 * - TokenUsage: Completion data from API responses
 * - ContextManagement*: Anthropic's context management edits
 * - EstimationState: Token estimation tracking for UI
 */

/**
 * Context management edit from Anthropic's API
 */
export interface ContextManagementEdit {
  type: "clear_tool_uses_20250919" | "clear_thinking_20251015";
  clearedInputTokens: number;
  clearedToolUses?: number;
  clearedThinkingTurns?: number;
}

export interface ContextManagementInfo {
  appliedEdits: ContextManagementEdit[];
}

/**
 * Token usage data from a completed request
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  maxInputTokens?: number | undefined;
  modelId?: string | undefined;
  contextManagement?: ContextManagementInfo | undefined;
  /** Number of messages in this request (for delta estimation on next turn) */
  messageCount?: number | undefined;
}

/**
 * Agent entry tracking token usage for a single LM call
 */
export interface AgentEntry {
  id: string;
  /** Short display name (e.g., "recon", "execute", or hash) */
  name: string;
  startTime: number;
  lastUpdateTime: number;
  /** Input tokens from the most recent turn */
  inputTokens: number;
  /** Output tokens from the most recent turn */
  outputTokens: number;
  /** Most recent actual input tokens (updated each turn, reflects post-summarization reductions) */
  lastActualInputTokens: number;
  /** Cumulative output tokens across all turns in this conversation */
  totalOutputTokens: number;
  /** Number of turns (request/response cycles) in this conversation */
  turnCount: number;
  /** Number of messages in the last completed request (for delta estimation) */
  lastMessageCount?: number | undefined;
  maxInputTokens?: number | undefined;
  estimatedInputTokens?: number | undefined;
  /** Estimated tokens for NEW messages only (delta from previous state) */
  estimatedDeltaTokens?: number | undefined;
  modelId?: string | undefined;
  status: "streaming" | "complete" | "error";
  contextManagement?: ContextManagementInfo | undefined;
  /** Whether this agent has been dimmed due to inactivity */
  dimmed: boolean;
  /** Is this the main/primary agent (first in conversation)? */
  isMain: boolean;
  /** Order in which this agent completed (for aging) */
  completionOrder?: number | undefined;
  /** Hash of system prompt - diagnostics only */
  systemPromptHash?: string | undefined;
  // Identity tracking (RFC 00033)
  /** Computed once at conversation start from toolSetHash */
  agentTypeHash?: string | undefined;
  /** Parent's conversation identifier if this is a subagent */
  parentConversationHash?: string | null | undefined;
  /** Conversation hashes of child agents spawned by this agent */
  childConversationHashes?: string[] | undefined;
  /** Hash of first user message (computed at conversation start) */
  firstUserMessageHash?: string | undefined;
  /** Preview of first user message (first ~50 chars, for display) */
  firstUserMessagePreview?: string | undefined;
  /** AI-generated title for the conversation (async, may be undefined initially) */
  generatedTitle?: string | undefined;

  /** Source of the token estimate (for diagnostics/UI) */
  estimationSource?: "exact" | "delta" | "estimated" | undefined;
  /** Stable conversation UUID from stateful marker sessionId (primary identity) */
  conversationId?: string | undefined;
  /** Whether VS Code summarization was detected (token drop ≥30%) */
  summarizationDetected?: boolean | undefined;
  /** Tokens freed by summarization (previous - current input tokens) */
  summarizationReduction?: number | undefined;
  /** Whether this request is a summarization request (detected from message content) */
  isSummarization?: boolean | undefined;
  /** Turns remaining before the ↓ suffix fades (set to 2 on summarization detection) */
  summarizationFadeTurns?: number | undefined;
}

/**
 * Token estimation state for status bar display.
 * Shows whether we have known actual token counts or are estimating.
 */
export interface EstimationState {
  /** Model family identifier */
  modelFamily: string;
  /** Known actual tokens from last API response */
  knownTokens: number;
  /** Number of messages with known token counts */
  knownMessageCount: number;
  /** Whether this is the most recent conversation state */
  isCurrent: boolean;
}

/** Agent aging configuration */
export const AGENT_DIM_AFTER_REQUESTS = 2; // Dim after 2 newer agents complete
export const AGENT_REMOVE_AFTER_REQUESTS = 5; // Remove after 5 newer agents complete
export const AGENT_CLEANUP_INTERVAL_MS = 2_000; // Check for stale agents every 2 seconds
