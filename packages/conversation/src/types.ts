/**
 * Pure conversation model types.
 *
 * These types describe the domain model for a conversation: its structure,
 * activity log entries, token usage, and subagent hierarchy. They have no
 * runtime dependencies and are shared between the VS Code extension and CLI.
 */

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
  /** Chronological activity log (messages, responses, compaction, errors). */
  activityLog: ActivityLogEntry[];
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

// ── Activity Log ──────────────────────────────────────────────────────

/**
 * Union of all entries in a conversation's activity log.
 * Sorted chronologically (newest first in the tree).
 */
export type ActivityLogEntry =
  | UserMessageEntry
  | AIResponseEntry
  | CompactionEntry
  | ErrorEntry;

/** State of an AI response in its lifecycle. */
export type AIResponseState =
  | "streaming"
  | "pending-characterization"
  | "characterized"
  | "uncharacterized"
  | "interrupted";

/** A user's message to the AI. */
export interface UserMessageEntry {
  type: "user-message";
  /** Sequence number (1-based, same as turnNumber). */
  sequenceNumber: number;
  /** Timestamp (ms) when the message was sent. */
  timestamp: number;
  /** Preview of the message text. */
  preview?: string;
  /** Token contribution to context (input tokens for this message). */
  tokenContribution?: number;
  /**
   * True if this entry represents a tool continuation (tool results sent back
   * to the model) rather than an actual user message.
   */
  isToolContinuation?: boolean;
}

/** Details of a single tool call made by the AI. */
export interface ToolCallDetail {
  /** Unique call ID (itemId from the OpenResponses stream). */
  callId: string;
  /** Tool name (e.g., "read_file", "grep_search"). */
  name: string;
  /** Parsed arguments object passed to the tool. */
  args: Record<string, unknown>;
  /**
   * The full result returned by the tool, if captured.
   * Populated when the tool continuation (next turn) delivers results
   * back to the model. Stored as the raw string output.
   */
  result?: string;
}

/** An AI response to the user. */
export interface AIResponseEntry {
  type: "ai-response";
  /** Sequence number (1-based, same as turnNumber). */
  sequenceNumber: number;
  /** Timestamp (ms) when the response started. */
  timestamp: number;
  /** Lifecycle state. */
  state: AIResponseState;
  /** Short characterization of what happened. */
  characterization?: string;
  /** Token contribution (output tokens for this response). */
  tokenContribution: number;
  /** Subagents spawned during this response. */
  subagentIds: string[];
  /** Full details of tools called during this response. */
  toolCalls?: ToolCallDetail[];
  /**
   * Names of tools called during this response.
   * Derived from toolCalls for backward compatibility.
   */
  toolsUsed?: string[];

  // ── Stored response data (populated at turn completion) ──────────

  /**
   * Full accumulated response text from the model.
   * Stored for preview generation and inspector display.
   */
  responseText?: string;
  /**
   * Token usage reported by the API for this turn.
   * Input tokens reflect the full context sent; output tokens are this response.
   */
  usage?: { inputTokens: number; outputTokens: number };
  /** Finish reason reported by the API (e.g., "stop", "tool-calls", "length"). */
  finishReason?: string;
  /** Response ID from the API. */
  responseId?: string;
  /**
   * Error message if characterization failed.
   * Stored so the inspector can show why labeling didn't work.
   */
  characterizationError?: string;
}

/**
 * A compaction milestone in the activity log.
 * Wraps the existing CompactionEvent with a discriminated `type` field.
 */
export interface CompactionEntry {
  type: "compaction";
  /** Timestamp (ms) when the compaction was observed. */
  timestamp: number;
  /** Turn number at the time of compaction. */
  turnNumber: number;
  /** Number of tokens freed by compaction. */
  freedTokens: number;
  /** Compaction source type. */
  compactionType: "summarization" | "context_management";
  /** Optional details about the compaction event. */
  details?: string;
}

/**
 * An error that occurred during a turn.
 */
export interface ErrorEntry {
  type: "error";
  /** Timestamp (ms) when the error was observed. */
  timestamp: number;
  /** Turn number at which the error occurred, if known. */
  turnNumber?: number;
  /** Human-readable error description. */
  message: string;
}

// ── Subagent ─────────────────────────────────────────────────────────

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
