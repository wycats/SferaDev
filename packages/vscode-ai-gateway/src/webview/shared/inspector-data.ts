/**
 * Structured data types for the inspector webview.
 *
 * These types define the payload shapes sent from the extension to the webview.
 * They are serializable (no VS Code imports) and form a discriminated union
 * so the webview can dispatch to entry-specific Svelte components.
 *
 * The extension resolves a URI to one of these payloads; the webview renders
 * it with proper components instead of pre-rendered markdown.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared field types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A file location — combines filePath, startLine, endLine into one concept.
 * Paths are workspace-relative when possible.
 */
export interface FileLocation {
  /** Workspace-relative path (e.g., "src/foo.ts") or absolute if outside workspace. */
  path: string;
  /** Absolute path for linking. */
  absolutePath: string;
  startLine?: number;
  endLine?: number;
  /** Detected language from file extension. */
  language?: string;
}

/** Tool call detail as sent to the webview. */
export interface InspectorToolCall {
  callId: string;
  name: string;
  /**
   * Tool arguments with location-related keys (filePath, startLine, endLine)
   * removed when they've been promoted to `location`.
   */
  args: Record<string, unknown>;
  /** Extracted file location from args (filePath + optional startLine/endLine). */
  location?: FileLocation;
  result?: InspectorToolResult;
}

/** Extracted tool result with format metadata. */
export interface InspectorToolResult {
  content: string;
  format: "text" | "json" | "markdown";
  /** Detected language for syntax highlighting (from file extension in args). */
  language?: string;
  lineCount: number;
  charCount: number;
}

/** Token display info — pre-formatted for display. */
export interface TokenDisplay {
  /** Formatted string (e.g., "1.2k"). */
  formatted: string;
  /** Raw numeric value. */
  raw: number;
}

/** Subagent info for display. */
export interface InspectorSubagent {
  conversationId: string;
  name: string;
  status: "streaming" | "complete" | "error";
  turnCount: number;
  tokens: { input: number; output: number };
  children: InspectorSubagent[];
}

/** Compaction event for display. */
export interface InspectorCompactionEvent {
  timestamp: string;
  turnNumber: number;
  freedTokens: TokenDisplay;
  type: "summarization" | "context_management";
  details?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry-specific payloads
// ─────────────────────────────────────────────────────────────────────────────

export interface InspectorUserMessage {
  kind: "user-message";
  title: string;
  sequenceNumber: number;
  timestamp: string;
  preview?: string;
  tokenContribution?: TokenDisplay;
  isToolContinuation: boolean;
  raw: unknown;
}

export interface InspectorAIResponse {
  kind: "ai-response";
  title: string;
  sequenceNumber: number;
  timestamp: string;
  state: string;
  characterization?: string;
  tokenContribution: TokenDisplay;
  subagentIds: string[];
  toolsUsed: string[];
  responseText?: string;
  toolCalls: InspectorToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
  finishReason?: string;
  responseId?: string;
  characterizationError?: string;
  raw: unknown;
}

export interface InspectorToolContinuation {
  kind: "tool-continuation";
  title: string;
  sequenceNumber: number;
  timestamp: string;
  preview?: string;
  tokenContribution?: TokenDisplay;
  tools: string[];
  raw: unknown;
}

export interface InspectorCompaction {
  kind: "compaction";
  title: string;
  timestamp: string;
  turnNumber: number;
  freedTokens: TokenDisplay;
  compactionType: "summarization" | "context_management";
  details?: string;
  raw: unknown;
}

export interface InspectorError {
  kind: "error";
  title: string;
  timestamp: string;
  turnNumber?: number;
  message: string;
  raw: unknown;
}

export interface InspectorTurn {
  kind: "turn";
  title: string;
  turnNumber: number;
  timestamp: string;
  characterization?: string;
  outputTokens: TokenDisplay;
  subagentIds: string[];
  streaming: boolean;
  raw: unknown;
}

export interface InspectorSubagentView {
  kind: "subagent";
  title: string;
  subagent: InspectorSubagent;
  raw: unknown;
}

export interface InspectorToolCallView {
  kind: "tool-call";
  title: string;
  toolCall: InspectorToolCall;
  turn: number;
  callId: string;
  toolName: string;
  raw: unknown;
}

export interface InspectorConversation {
  kind: "conversation";
  title: string;
  id: string;
  modelId: string;
  status: string;
  startTime: string;
  lastActiveTime: string;
  turnCount: number;
  totalOutputTokens: TokenDisplay;
  firstMessagePreview?: string;
  workspaceFolder?: string;
  tokens: {
    input: TokenDisplay;
    output: TokenDisplay;
    maxInput: TokenDisplay;
  };
  compactionEvents: InspectorCompactionEvent[];
  subagents: InspectorSubagent[];
  activitySummary: InspectorActivitySummaryEntry[];
  entries: InspectorEntryData[];
}

export interface InspectorHistory {
  kind: "history";
  title: string;
  activitySummary: InspectorActivitySummaryEntry[];
  entries: InspectorEntryData[];
}

/** Summary row for the activity log table. */
export interface InspectorActivitySummaryEntry {
  index: number;
  type: string;
  identifier: string;
  timestamp: string;
}

export interface InspectorNotFound {
  kind: "not-found";
  title: string;
  message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Discriminated union
// ─────────────────────────────────────────────────────────────────────────────

/** Any single entry that can be displayed in the inspector. */
export type InspectorEntryData =
  | InspectorUserMessage
  | InspectorAIResponse
  | InspectorToolContinuation
  | InspectorCompaction
  | InspectorError
  | InspectorTurn
  | InspectorSubagentView
  | InspectorToolCallView;

/** Top-level inspector payload — the webview receives one of these. */
export type InspectorData =
  | InspectorEntryData
  | InspectorConversation
  | InspectorHistory
  | InspectorNotFound;
