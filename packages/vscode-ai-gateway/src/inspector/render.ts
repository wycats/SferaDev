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
import { formatTokens } from "../tokens/display.js";

function renderHeader(title: string, level: number): string {
  const prefix = "#".repeat(Math.min(Math.max(level, 1), 6));
  return `${prefix} ${title}\n\n`;
}

function escapeTableValue(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function renderTable(rows: Array<[string, string]>): string {
  const lines = ["| Field | Value |", "| --- | --- |"];
  for (const [field, value] of rows) {
    lines.push(`| ${escapeTableValue(field)} | ${escapeTableValue(value)} |`);
  }
  return `${lines.join("\n")}\n\n`;
}

function renderJsonBlock(value: unknown): string {
  const json = JSON.stringify(value, null, 2) ?? "";
  return `\`\`\`json\n${json}\n\`\`\`\n\n`;
}

function formatTimestamp(value: number | undefined): string {
  if (value === undefined) return "undefined";
  return new Date(value).toISOString();
}

function formatTokenCount(value: number | undefined): string {
  if (value === undefined) return "undefined";
  return `${formatTokens(value)} (${value.toString()})`;
}

function formatValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value.length > 0 ? value : "(empty)";
  if (typeof value === "number" || typeof value === "boolean") {
    return value.toString();
  }
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

function renderActivitySummaryTable(entries: ActivityLogEntry[]): string {
  const lines = [
    "| Index | Type | Identifier | Timestamp |",
    "| --- | --- | --- | --- |",
  ];

  entries.forEach((entry, index) => {
    const identifier = getEntryIdentifier(entry);
    lines.push(
      `| ${index.toString()} | ${entry.type} | ${identifier} | ${formatTimestamp("timestamp" in entry ? entry.timestamp : undefined)} |`,
    );
  });

  return `${lines.join("\n")}\n\n`;
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

function renderUserMessageSection(
  entry: UserMessageEntry,
  headingLevel: number,
): string {
  const rows: Array<[string, string]> = [
    ["type", entry.type],
    ["sequenceNumber", entry.sequenceNumber.toString()],
    ["timestamp", formatTimestamp(entry.timestamp)],
    ["preview", formatValue(entry.preview)],
    ["tokenContribution", formatTokenCount(entry.tokenContribution)],
    ["isToolContinuation", formatValue(entry.isToolContinuation)],
  ];

  return (
    renderHeader(
      `User Message #${entry.sequenceNumber.toString()}`,
      headingLevel,
    ) +
    renderTable(rows) +
    renderHeader("Raw", headingLevel + 1) +
    renderJsonBlock(entry)
  );
}

function renderAIResponseSection(
  entry: AIResponseEntry,
  headingLevel: number,
): string {
  const rows: Array<[string, string]> = [
    ["type", entry.type],
    ["sequenceNumber", entry.sequenceNumber.toString()],
    ["timestamp", formatTimestamp(entry.timestamp)],
    ["state", entry.state],
    ["characterization", formatValue(entry.characterization)],
    ["tokenContribution", formatTokenCount(entry.tokenContribution)],
    ["subagentIds", formatValue(entry.subagentIds)],
    ["toolsUsed", formatValue(entry.toolsUsed)],
  ];

  return (
    renderHeader(
      `AI Response #${entry.sequenceNumber.toString()}`,
      headingLevel,
    ) +
    renderTable(rows) +
    renderHeader("Raw", headingLevel + 1) +
    renderJsonBlock(entry)
  );
}

function renderToolContinuationSection(
  entry: UserMessageEntry,
  tools: string[],
  headingLevel: number,
): string {
  const rows: Array<[string, string]> = [
    ["type", entry.type],
    ["sequenceNumber", entry.sequenceNumber.toString()],
    ["timestamp", formatTimestamp(entry.timestamp)],
    ["preview", formatValue(entry.preview)],
    ["tokenContribution", formatTokenCount(entry.tokenContribution)],
    ["isToolContinuation", formatValue(entry.isToolContinuation)],
    ["tools", formatValue(tools)],
  ];

  return (
    renderHeader(
      `Tool Continuation #${entry.sequenceNumber.toString()}`,
      headingLevel,
    ) +
    renderTable(rows) +
    renderHeader("Raw", headingLevel + 1) +
    renderJsonBlock({ entry, tools })
  );
}

function renderCompactionSection(
  entry: CompactionEntry,
  headingLevel: number,
): string {
  const rows: Array<[string, string]> = [
    ["type", entry.type],
    ["timestamp", formatTimestamp(entry.timestamp)],
    ["turnNumber", entry.turnNumber.toString()],
    ["freedTokens", formatTokenCount(entry.freedTokens)],
    ["compactionType", entry.compactionType],
    ["details", formatValue(entry.details)],
  ];

  return (
    renderHeader(
      `Compaction (Turn ${entry.turnNumber.toString()})`,
      headingLevel,
    ) +
    renderTable(rows) +
    renderHeader("Raw", headingLevel + 1) +
    renderJsonBlock(entry)
  );
}

function renderErrorSection(entry: ErrorEntry, headingLevel: number): string {
  const rows: Array<[string, string]> = [
    ["type", entry.type],
    ["timestamp", formatTimestamp(entry.timestamp)],
    ["turnNumber", formatValue(entry.turnNumber)],
    ["message", entry.message],
  ];

  return (
    renderHeader("Error", headingLevel) +
    renderTable(rows) +
    renderHeader("Raw", headingLevel + 1) +
    renderJsonBlock(entry)
  );
}

function renderTurnSection(entry: TurnEntry, headingLevel: number): string {
  const rows: Array<[string, string]> = [
    ["type", entry.type],
    ["turnNumber", entry.turnNumber.toString()],
    ["timestamp", formatTimestamp(entry.timestamp)],
    ["characterization", formatValue(entry.characterization)],
    ["outputTokens", formatTokenCount(entry.outputTokens)],
    ["subagentIds", formatValue(entry.subagentIds)],
    ["streaming", formatValue(entry.streaming)],
  ];

  return (
    renderHeader(`Turn ${entry.turnNumber.toString()}`, headingLevel) +
    renderTable(rows) +
    renderHeader("Raw", headingLevel + 1) +
    renderJsonBlock(entry)
  );
}

function renderSubagentSection(
  subagent: Subagent,
  headingLevel: number,
): string {
  const rows: Array<[string, string]> = [
    ["conversationId", subagent.conversationId],
    ["name", subagent.name],
    ["status", subagent.status],
    ["turnCount", subagent.turnCount.toString()],
    ["tokens.input", formatTokenCount(subagent.tokens.input)],
    ["tokens.output", formatTokenCount(subagent.tokens.output)],
    ["children", subagent.children.length.toString()],
  ];

  let output =
    renderHeader(`Subagent: ${subagent.name}`, headingLevel) +
    renderTable(rows) +
    renderHeader("Raw", headingLevel + 1) +
    renderJsonBlock(subagent);

  if (subagent.children.length > 0) {
    for (const child of subagent.children) {
      output += renderSubagentSection(child, headingLevel + 1);
    }
  }

  return output;
}

function renderCompactionEvents(events: CompactionEvent[]): string {
  if (events.length === 0) {
    return "No compaction events recorded.\n\n";
  }

  const lines = [
    "| Timestamp | Turn | Freed Tokens | Type | Details |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const event of events) {
    lines.push(
      `| ${formatTimestamp(event.timestamp)} | ${event.turnNumber.toString()} | ${formatTokenCount(event.freedTokens)} | ${event.type} | ${escapeTableValue(formatValue(event.details))} |`,
    );
  }

  return `${lines.join("\n")}\n\n`;
}

function renderEntryDetails(
  entry: ActivityLogEntry,
  conversation: Conversation,
  headingLevel: number,
): string {
  switch (entry.type) {
    case "user-message":
      return renderUserMessageSection(entry, headingLevel);
    case "ai-response":
      return renderAIResponseSection(entry, headingLevel);
    case "compaction":
      return renderCompactionSection(entry, headingLevel);
    case "error":
      return renderErrorSection(entry, headingLevel);
    default: {
      return (
        renderHeader("Entry", headingLevel) +
        renderJsonBlock(entry) +
        renderHeader("Conversation", headingLevel + 1) +
        renderJsonBlock(conversation)
      );
    }
  }
}

function renderEntryList(
  entries: ActivityLogEntry[],
  conversation: Conversation,
  headingLevel: number,
): string {
  if (entries.length === 0) {
    return "No entries available.\n\n";
  }

  return entries
    .map((entry) => renderEntryDetails(entry, conversation, headingLevel))
    .join("");
}

export function renderConversation(conversation: Conversation): string {
  const metadataRows: Array<[string, string]> = [
    ["id", conversation.id],
    ["title", conversation.title],
    ["firstMessagePreview", formatValue(conversation.firstMessagePreview)],
    ["modelId", conversation.modelId],
    ["status", conversation.status],
    ["startTime", formatTimestamp(conversation.startTime)],
    ["lastActiveTime", formatTimestamp(conversation.lastActiveTime)],
    ["turnCount", conversation.turnCount.toString()],
    ["totalOutputTokens", formatTokenCount(conversation.totalOutputTokens)],
    ["workspaceFolder", formatValue(conversation.workspaceFolder)],
  ];

  const tokensRows: Array<[string, string]> = [
    ["input", formatTokenCount(conversation.tokens.input)],
    ["output", formatTokenCount(conversation.tokens.output)],
    ["maxInput", formatTokenCount(conversation.tokens.maxInput)],
  ];

  let output =
    renderHeader(`Conversation: ${conversation.title}`, 1) +
    renderHeader("Metadata", 2) +
    renderTable(metadataRows) +
    renderHeader("Tokens", 2) +
    renderTable(tokensRows) +
    renderHeader("Compaction Events", 2) +
    renderCompactionEvents(conversation.compactionEvents) +
    renderHeader("Activity Log Summary", 2) +
    renderActivitySummaryTable(conversation.activityLog);

  if (conversation.subagents.length > 0) {
    output += renderHeader("Subagents", 2);
    for (const subagent of conversation.subagents) {
      output += renderSubagentSection(subagent, 3);
    }
  } else {
    output += renderHeader("Subagents", 2);
    output += "No subagents recorded.\n\n";
  }

  output += renderHeader("Activity Log Detail", 2);
  output += renderEntryList(conversation.activityLog, conversation, 3);

  return output;
}

export function renderUserMessage(
  entry: UserMessageEntry,
  _conversation: Conversation,
): string {
  return renderUserMessageSection(entry, 1);
}

export function renderAIResponse(
  entry: AIResponseEntry,
  _conversation: Conversation,
): string {
  return renderAIResponseSection(entry, 1);
}

export function renderToolContinuation(
  entry: UserMessageEntry,
  tools: string[],
  _conversation: Conversation,
): string {
  return renderToolContinuationSection(entry, tools, 1);
}

export function renderCompaction(
  entry: CompactionEntry,
  _conversation: Conversation,
): string {
  return renderCompactionSection(entry, 1);
}

export function renderError(
  entry: ErrorEntry,
  _conversation: Conversation,
): string {
  return renderErrorSection(entry, 1);
}

export function renderSubagent(
  subagent: Subagent,
  _conversation: Conversation,
): string {
  return renderSubagentSection(subagent, 1);
}

export function renderTurn(
  entry: TurnEntry,
  _conversation: Conversation,
): string {
  return renderTurnSection(entry, 1);
}

export function renderHistory(
  entries: ActivityLogEntry[],
  conversation: Conversation,
): string {
  let output = renderHeader("History", 1);
  output += renderHeader("Summary", 2);
  output += renderActivitySummaryTable(entries);
  output += renderHeader("Entries", 2);
  output += renderEntryList(entries, conversation, 3);
  return output;
}

/**
 * Extract readable content from a tool result string.
 *
 * Tool results can be stored in several formats:
 * 1. Plain text (ideal) — return as-is
 * 2. JSON-stringified VS Code internal format — extract .value fields
 *    e.g., [{"$mid":21,"value":"actual content",...}]
 * 3. JSON data — pretty-print it
 *
 * This handles legacy persisted data that used JSON.stringify on the
 * raw LanguageModelToolResultPart.content array.
 */
function extractToolResultContent(result: string): {
  content: string;
  format: "text" | "json" | "extracted";
} {
  // Quick check: if it doesn't look like JSON, it's plain text
  const trimmed = result.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
    return { content: result, format: "text" };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;

    // Check for VS Code internal format: array with $mid and value fields
    if (Array.isArray(parsed)) {
      const textParts: string[] = [];
      for (const item of parsed) {
        if (
          typeof item === "object" &&
          item !== null &&
          "value" in item &&
          typeof (item as { value: unknown }).value === "string"
        ) {
          textParts.push((item as { value: string }).value);
        }
      }
      if (textParts.length > 0) {
        return { content: textParts.join("\n"), format: "extracted" };
      }
    }

    // It's valid JSON but not the VS Code format — pretty-print it
    return { content: JSON.stringify(parsed, null, 2), format: "json" };
  } catch {
    // Not valid JSON — treat as plain text
    return { content: result, format: "text" };
  }
}

export function renderToolCall(
  toolCall: ToolCallDetail,
  aiResponse: AIResponseEntry,
  _conversation: Conversation,
): string {
  let output = renderHeader(`Tool Call: ${toolCall.name}`, 1);

  output += renderHeader("Request", 2);
  output += renderTable([
    ["Call ID", toolCall.callId],
    ["Tool Name", toolCall.name],
    ["Turn", `#${aiResponse.sequenceNumber.toString()}`],
  ]);

  output += renderHeader("Arguments", 3);
  output += renderJsonBlock(toolCall.args);

  if (toolCall.result !== undefined) {
    const { content, format } = extractToolResultContent(toolCall.result);
    const lines = content.split("\n");
    const lineCount = lines.length;
    const charCount = content.length;

    output += renderHeader("Response", 2);
    output += renderTable([
      ["Lines", lineCount.toString()],
      ["Characters", charCount.toString()],
      ...(format === "extracted" ? [["Note", "Extracted from legacy format"] as [string, string]] : []),
    ]);

    output += renderHeader("Content", 3);
    // Use appropriate code fence based on format
    const lang = format === "json" ? "json" : "";
    output += "```" + lang + "\n" + content + "\n```\n\n";
  } else {
    output += renderHeader("Response", 2);
    output += "*No result captured (tool may still be executing)*\n\n";
  }

  return output;
}
