/**
 * Conversation snapshot for UI and storage.
 */
export interface Conversation {
  /** Stable conversation identifier. */
  id: string;
  /** Human-readable title for display. */
  title: string;
  /** Preview of the first user message, if available. */
  firstMessagePreview?: string;
  /** Model identifier for the conversation. */
  modelId: string;
  /** Conversation status derived from agent activity. */
  status: "active" | "idle" | "archived";
  /** Timestamp (ms) when the conversation started. */
  startTime: number;
  /** Timestamp (ms) of the most recent activity. */
  lastActiveTime: number;
  /** Token usage for the most recent turn. */
  tokens: { input: number; output: number; maxInput: number };
  /** Number of turns completed. */
  turnCount: number;
  /** Total output tokens across all turns. */
  totalOutputTokens: number;
  /** Compaction events observed for this conversation. */
  compactionEvents: CompactionEvent[];
  /** Nested subagent hierarchy. */
  subagents: Subagent[];
  /** Workspace folder that owns the conversation, if available. */
  workspaceFolder?: string;
}

/**
 * Compaction event derived from summarization or context management edits.
 */
export interface CompactionEvent {
  /** Timestamp (ms) when the compaction was observed. */
  timestamp: number;
  /** Turn number at the time of compaction. */
  turnNumber: number;
  /** Number of tokens freed by compaction. */
  freedTokens: number;
  /** Compaction source type. */
  type: "summarization" | "context_management";
  /** Optional details about the compaction event. */
  details?: string;
}

/**
 * Subagent node used to build the agent hierarchy.
 */
export interface Subagent {
  /** Stable conversation identifier for the subagent. */
  conversationId: string;
  /** Display name for the subagent. */
  name: string;
  /** Token usage for the most recent turn. */
  tokens: { input: number; output: number };
  /** Number of turns completed by this subagent. */
  turnCount: number;
  /** Current status of the subagent. */
  status: "streaming" | "complete" | "error";
  /** Child subagents spawned by this subagent. */
  children: Subagent[];
}
