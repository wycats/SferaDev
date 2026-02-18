/**
 * Serialize conversation model types into InspectorData payloads.
 *
 * This module bridges the gap between @vercel/conversation domain types
 * and the webview-safe InspectorData types. Each function converts a
 * specific entry type into its inspector representation, pre-computing
 * display values (formatted tokens, timestamps, extracted tool results).
 */

import type {
  ActivityLogEntry,
  AIResponseEntry,
  CompactionEntry,
  CompactionEvent,
  Conversation,
  ErrorEntry,
  Subagent,
  ToolCallDetail,
  UserMessageEntry,
} from "@vercel/conversation";
import type { TurnEntry } from "../conversation/types.js";
import { buildTree } from "@vercel/conversation";
import { formatTokens } from "../tokens/display.js";
import { extractToolResultContent } from "./render.js";
import type {
  FileLocation,
  InspectorAIResponse,
  InspectorActivitySummaryEntry,
  InspectorCompaction,
  InspectorCompactionEvent,
  InspectorConversation,
  InspectorEntryData,
  InspectorError,
  InspectorHistory,
  InspectorNotFound,
  InspectorSubagent,
  InspectorSubagentView,
  InspectorToolCall,
  InspectorToolCallView,
  InspectorToolContinuation,
  InspectorToolResult,
  InspectorTurn,
  InspectorUserMessage,
  TokenDisplay,
} from "../webview/shared/inspector-data.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatTimestamp(value: number | undefined): string {
  if (value === undefined) return "";
  return new Date(value).toISOString();
}

function toTokenDisplay(value: number | undefined): TokenDisplay {
  const raw = value ?? 0;
  return { formatted: formatTokens(raw), raw };
}

/**
 * Detect language from a file path extension.
 * Used to provide language hints for syntax highlighting tool results.
 */
function detectLanguageFromPath(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext) return undefined;

  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    md: "markdown",
    svelte: "svelte",
    html: "html",
    css: "css",
    scss: "scss",
    py: "python",
    rs: "rust",
    go: "go",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    sql: "sql",
    graphql: "graphql",
    vue: "vue",
    xml: "xml",
    swift: "swift",
    kt: "kotlin",
    java: "java",
    rb: "ruby",
    php: "php",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
  };

  return langMap[ext];
}

function serializeToolResult(
  result: string | undefined,
  _args: Record<string, unknown>,
): InspectorToolResult | undefined {
  if (result === undefined) return undefined;

  const { content, format } = extractToolResultContent(result);
  const lines = content.split("\n");

  // Don't infer language from args — the result content may not be code.
  // Language is only set when format is "json" (detected from content).
  return {
    content,
    format,
    lineCount: lines.length,
    charCount: content.length,
  };
}

/** Keys that are promoted into `FileLocation` and removed from displayed args. */
const LOCATION_PATH_KEYS = [
  "filePath",
  "path",
  "file",
  "filename",
  "uri",
  "dirPath",
] as const;
const LOCATION_LINE_KEYS = ["startLine", "endLine"] as const;

/**
 * Extract a FileLocation from tool call args if a file path is present.
 * Returns the location and the remaining args with location keys removed.
 */
function extractLocation(
  args: Record<string, unknown>,
  workspaceFolder: string | undefined,
): { location?: FileLocation; remainingArgs: Record<string, unknown> } {
  // Find the file path key
  let pathKey: string | undefined;
  let absolutePath: string | undefined;

  for (const key of LOCATION_PATH_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) {
      pathKey = key;
      absolutePath = value;
      break;
    }
  }

  if (pathKey === undefined || absolutePath === undefined) {
    return { remainingArgs: args };
  }

  // Compute workspace-relative path
  let relativePath = absolutePath;
  if (
    workspaceFolder !== undefined &&
    absolutePath.startsWith(workspaceFolder)
  ) {
    relativePath = absolutePath.slice(workspaceFolder.length);
    if (relativePath.startsWith("/")) {
      relativePath = relativePath.slice(1);
    }
  }

  const language = detectLanguageFromPath(absolutePath);

  const location: FileLocation = {
    path: relativePath,
    absolutePath,
    ...(language !== undefined ? { language } : {}),
  };

  // Extract line numbers
  const startLine = args["startLine"];
  const endLine = args["endLine"];
  if (typeof startLine === "number") {
    location.startLine = startLine;
  }
  if (typeof endLine === "number") {
    location.endLine = endLine;
  }

  // Build remaining args without location keys
  const keysToRemove = new Set<string>([pathKey]);
  for (const key of LOCATION_LINE_KEYS) {
    if (key in args) {
      keysToRemove.add(key);
    }
  }

  const remainingArgs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!keysToRemove.has(key)) {
      remainingArgs[key] = value;
    }
  }

  return { location, remainingArgs };
}

function serializeToolCall(
  toolCall: ToolCallDetail,
  workspaceFolder: string | undefined,
): InspectorToolCall {
  const result = serializeToolResult(toolCall.result, toolCall.args);
  const { location, remainingArgs } = extractLocation(
    toolCall.args,
    workspaceFolder,
  );
  return {
    callId: toolCall.callId,
    name: toolCall.name,
    args: remainingArgs,
    ...(location !== undefined ? { location } : {}),
    ...(result !== undefined ? { result } : {}),
  };
}

function serializeSubagent(subagent: Subagent): InspectorSubagent {
  return {
    conversationId: subagent.conversationId,
    name: subagent.name,
    status: subagent.status,
    turnCount: subagent.turnCount,
    tokens: subagent.tokens,
    children: subagent.children.map(serializeSubagent),
  };
}

function serializeCompactionEvent(
  event: CompactionEvent,
): InspectorCompactionEvent {
  return {
    timestamp: formatTimestamp(event.timestamp),
    turnNumber: event.turnNumber,
    freedTokens: toTokenDisplay(event.freedTokens),
    type: event.type,
    ...(event.details !== undefined ? { details: event.details } : {}),
  };
}

function getEntryIdentifier(entry: ActivityLogEntry): string {
  if (entry.type === "user-message" || entry.type === "ai-response") {
    return entry.sequenceNumber.toString();
  }
  if (entry.type === "compaction") {
    return entry.turnNumber.toString();
  }
  if (entry.type === "error") {
    return entry.turnNumber?.toString() ?? entry.timestamp.toString();
  }
  return "";
}

function serializeActivitySummary(
  entries: ActivityLogEntry[],
): InspectorActivitySummaryEntry[] {
  return entries.map((entry, index) => ({
    index,
    type: entry.type,
    identifier: getEntryIdentifier(entry),
    timestamp: formatTimestamp(
      "timestamp" in entry ? entry.timestamp : undefined,
    ),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry serializers
// ─────────────────────────────────────────────────────────────────────────────

function serializeUserMessage(entry: UserMessageEntry): InspectorUserMessage {
  return {
    kind: "user-message",
    title: `User Message #${entry.sequenceNumber.toString()}`,
    sequenceNumber: entry.sequenceNumber,
    timestamp: formatTimestamp(entry.timestamp),
    ...(entry.preview !== undefined ? { preview: entry.preview } : {}),
    ...(entry.tokenContribution !== undefined
      ? { tokenContribution: toTokenDisplay(entry.tokenContribution) }
      : {}),
    isToolContinuation: entry.isToolContinuation ?? false,
    raw: entry,
  };
}

function serializeAIResponse(
  entry: AIResponseEntry,
  workspaceFolder?: string,
): InspectorAIResponse {
  return {
    kind: "ai-response",
    title: `AI Response #${entry.sequenceNumber.toString()}`,
    sequenceNumber: entry.sequenceNumber,
    timestamp: formatTimestamp(entry.timestamp),
    state: entry.state,
    ...(entry.characterization !== undefined
      ? { characterization: entry.characterization }
      : {}),
    tokenContribution: toTokenDisplay(entry.tokenContribution),
    subagentIds: entry.subagentIds,
    toolsUsed: entry.toolsUsed ?? [],
    ...(entry.responseText !== undefined
      ? { responseText: entry.responseText }
      : {}),
    toolCalls: (entry.toolCalls ?? []).map((tc) =>
      serializeToolCall(tc, workspaceFolder),
    ),
    ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
    ...(entry.finishReason !== undefined
      ? { finishReason: entry.finishReason }
      : {}),
    ...(entry.responseId !== undefined ? { responseId: entry.responseId } : {}),
    ...(entry.characterizationError !== undefined
      ? { characterizationError: entry.characterizationError }
      : {}),
    raw: entry,
  };
}

function serializeCompaction(entry: CompactionEntry): InspectorCompaction {
  return {
    kind: "compaction",
    title: `Compaction (Turn ${entry.turnNumber.toString()})`,
    timestamp: formatTimestamp(entry.timestamp),
    turnNumber: entry.turnNumber,
    freedTokens: toTokenDisplay(entry.freedTokens),
    compactionType: entry.compactionType,
    ...(entry.details !== undefined ? { details: entry.details } : {}),
    raw: entry,
  };
}

function serializeError(entry: ErrorEntry): InspectorError {
  return {
    kind: "error",
    title: "Error",
    timestamp: formatTimestamp(entry.timestamp),
    ...(entry.turnNumber !== undefined ? { turnNumber: entry.turnNumber } : {}),
    message: entry.message,
    raw: entry,
  };
}

function serializeTurn(entry: TurnEntry): InspectorTurn {
  return {
    kind: "turn",
    title: `Turn ${entry.turnNumber.toString()}`,
    turnNumber: entry.turnNumber,
    timestamp: formatTimestamp(entry.timestamp),
    ...(entry.characterization !== undefined
      ? { characterization: entry.characterization }
      : {}),
    outputTokens: toTokenDisplay(entry.outputTokens),
    subagentIds: entry.subagentIds,
    streaming: entry.streaming,
    raw: entry,
  };
}

function serializeEntry(
  entry: ActivityLogEntry,
  workspaceFolder?: string,
): InspectorEntryData {
  switch (entry.type) {
    case "user-message":
      return serializeUserMessage(entry);
    case "ai-response":
      return serializeAIResponse(entry, workspaceFolder);
    case "compaction":
      return serializeCompaction(entry);
    case "error":
      return serializeError(entry);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level serializers (match content-provider switch cases)
// ─────────────────────────────────────────────────────────────────────────────

export function serializeConversationData(
  conversation: Conversation,
): InspectorConversation {
  return {
    kind: "conversation",
    title: `Conversation: ${conversation.title}`,
    id: conversation.id,
    modelId: conversation.modelId,
    status: conversation.status,
    startTime: formatTimestamp(conversation.startTime),
    lastActiveTime: formatTimestamp(conversation.lastActiveTime),
    turnCount: conversation.turnCount,
    totalOutputTokens: toTokenDisplay(conversation.totalOutputTokens),
    ...(conversation.firstMessagePreview !== undefined
      ? { firstMessagePreview: conversation.firstMessagePreview }
      : {}),
    ...(conversation.workspaceFolder !== undefined
      ? { workspaceFolder: conversation.workspaceFolder }
      : {}),
    tokens: {
      input: toTokenDisplay(conversation.tokens.input),
      output: toTokenDisplay(conversation.tokens.output),
      maxInput: toTokenDisplay(conversation.tokens.maxInput),
    },
    compactionEvents: conversation.compactionEvents.map(
      serializeCompactionEvent,
    ),
    subagents: conversation.subagents.map(serializeSubagent),
    activitySummary: serializeActivitySummary(conversation.activityLog),
    entries: conversation.activityLog.map((e) =>
      serializeEntry(e, conversation.workspaceFolder),
    ),
  };
}

export function serializeHistoryData(
  entries: ActivityLogEntry[],
  workspaceFolder?: string,
): InspectorHistory {
  const historyEntries = buildTree(entries).historyEntries;
  return {
    kind: "history",
    title: "History",
    activitySummary: serializeActivitySummary(historyEntries),
    entries: historyEntries.map((e) => serializeEntry(e, workspaceFolder)),
  };
}

export function serializeUserMessageData(
  entry: UserMessageEntry,
): InspectorUserMessage {
  return serializeUserMessage(entry);
}

export function serializeAIResponseData(
  entry: AIResponseEntry,
  workspaceFolder?: string,
): InspectorAIResponse {
  return serializeAIResponse(entry, workspaceFolder);
}

export function serializeToolContinuationData(
  entry: UserMessageEntry,
  tools: string[],
): InspectorToolContinuation {
  return {
    kind: "tool-continuation",
    title: `Tool Continuation #${entry.sequenceNumber.toString()}`,
    sequenceNumber: entry.sequenceNumber,
    timestamp: formatTimestamp(entry.timestamp),
    ...(entry.preview !== undefined ? { preview: entry.preview } : {}),
    ...(entry.tokenContribution !== undefined
      ? { tokenContribution: toTokenDisplay(entry.tokenContribution) }
      : {}),
    tools,
    raw: { entry, tools },
  };
}

export function serializeCompactionData(
  entry: CompactionEntry,
): InspectorCompaction {
  return serializeCompaction(entry);
}

export function serializeErrorData(entry: ErrorEntry): InspectorError {
  return serializeError(entry);
}

export function serializeSubagentData(
  subagent: Subagent,
): InspectorSubagentView {
  return {
    kind: "subagent",
    title: `Subagent: ${subagent.name}`,
    subagent: serializeSubagent(subagent),
    raw: subagent,
  };
}

export function serializeTurnData(entry: TurnEntry): InspectorTurn {
  return serializeTurn(entry);
}

export function serializeToolCallData(
  toolCall: ToolCallDetail,
  aiResponse: AIResponseEntry,
  workspaceFolder?: string,
): InspectorToolCallView {
  return {
    kind: "tool-call",
    title: `Tool Call: ${toolCall.name}`,
    toolCall: serializeToolCall(toolCall, workspaceFolder),
    turn: aiResponse.sequenceNumber,
    callId: toolCall.callId,
    toolName: toolCall.name,
    raw: { toolCall, aiResponse },
  };
}

export function serializeNotFound(message?: string): InspectorNotFound {
  return {
    kind: "not-found",
    title: "Not Found",
    message: message ?? "The requested item was not found.",
  };
}
