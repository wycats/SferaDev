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

  let output =
    renderHeader(
      `AI Response #${entry.sequenceNumber.toString()}`,
      headingLevel,
    ) + renderTable(rows);

  // Render response text if present
  if (entry.responseText && entry.responseText.length > 0) {
    output += renderHeader("Response", headingLevel + 1);
    const { content, format } = extractToolResultContent(entry.responseText);
    if (format === "markdown") {
      output += content + "\n\n";
    } else {
      output += content + "\n\n";
    }
  }

  // Render tool calls with extracted results
  if (entry.toolCalls && entry.toolCalls.length > 0) {
    output += renderHeader("Tool Calls", headingLevel + 1);
    for (const toolCall of entry.toolCalls) {
      output += renderToolCallInline(toolCall, headingLevel + 2);
    }
  }

  // Raw JSON at the bottom for debugging
  output += renderHeader("Raw", headingLevel + 1);
  output += renderJsonBlock(entry);

  return output;
}

/**
 * Render a tool call inline within an AI response section.
 * More compact than the full renderToolCall export.
 */
function renderToolCallInline(
  toolCall: ToolCallDetail,
  headingLevel: number,
): string {
  let output = renderHeader(`${toolCall.name}`, headingLevel);

  // Arguments as compact JSON
  output += renderHeader("Arguments", headingLevel + 1);
  output += renderJsonBlock(toolCall.args);

  // Result with smart extraction
  if (toolCall.result !== undefined) {
    output += renderHeader("Result", headingLevel + 1);
    const { content, format } = extractToolResultContent(toolCall.result);

    if (format === "markdown") {
      // Render markdown directly
      output += content + "\n\n";
    } else if (format === "json") {
      output += "```json\n" + content + "\n```\n\n";
    } else {
      // Plain text — check if it's short enough to show inline
      if (content.length < 500 && !content.includes("\n")) {
        output += content + "\n\n";
      } else {
        output += "```\n" + content + "\n```\n\n";
      }
    }
  }

  return output;
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
 *
 * Strategy:
 * 1. If not JSON, return as-is
 * 2. Extract all string values from JSON recursively
 * 3. Prefer strings that look like content (long, contains markdown)
 * 4. If extracted content looks like markdown, render as markdown
 */
export function extractToolResultContent(result: string): {
  content: string;
  format: "text" | "json" | "markdown";
} {
  // Quick check: if it doesn't look like JSON, check for markdown
  const trimmed = result.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
    const format = looksLikeMarkdown(result) ? "markdown" : "text";
    return { content: result, format };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;

    // Extract all string values from the JSON
    const strings = extractStringsFromJson(parsed);

    // Find the best content candidate
    const content = selectBestContent(strings);

    if (content !== null) {
      const format = looksLikeMarkdown(content) ? "markdown" : "text";
      return { content, format };
    }

    // No good string content found — pretty-print the JSON
    return { content: JSON.stringify(parsed, null, 2), format: "json" };
  } catch {
    // Not valid JSON — check for markdown
    const format = looksLikeMarkdown(result) ? "markdown" : "text";
    return { content: result, format };
  }
}

/**
 * Recursively extract all string values from a JSON structure.
 * Returns strings with their "depth" (how nested they are) and key name if available.
 */
function extractStringsFromJson(
  value: unknown,
  depth = 0,
  key?: string,
): Array<{ value: string; depth: number; key?: string }> {
  if (typeof value === "string") {
    // With exactOptionalPropertyTypes, we must not include key if undefined
    const result: { value: string; depth: number; key?: string } = {
      value,
      depth,
    };
    if (key !== undefined) {
      result.key = key;
    }
    return [result];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      extractStringsFromJson(item, depth + 1, `[${index.toString()}]`),
    );
  }

  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([k, v]) =>
      extractStringsFromJson(v, depth + 1, k),
    );
  }

  return [];
}

/**
 * Select the best content string from extracted values.
 * Prefers: longer strings, strings with markdown, strings from "value"/"content" keys.
 */
function selectBestContent(
  strings: Array<{ value: string; depth: number; key?: string }>,
): string | null {
  if (strings.length === 0) return null;

  // Filter out very short strings (likely metadata)
  const candidates = strings.filter((s) => s.value.length > 20);
  if (candidates.length === 0) {
    // Fall back to longest string if all are short
    const longest = strings.reduce((a, b) =>
      a.value.length > b.value.length ? a : b,
    );
    return longest.value.length > 0 ? longest.value : null;
  }

  // Score each candidate
  const scored = candidates.map((s) => ({
    ...s,
    score: scoreContent(s.value, s.key),
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // If top candidate has markdown, return it
  // If multiple candidates have similar scores, join them
  const best = scored[0];
  if (best === undefined) return null;

  // Check if there are multiple high-scoring candidates (within 50% of best)
  const threshold = best.score * 0.5;
  const topCandidates = scored.filter((s) => s.score >= threshold);

  if (topCandidates.length > 1 && topCandidates.every((c) => c.score > 10)) {
    // Multiple good candidates — join them
    return topCandidates.map((c) => c.value).join("\n\n");
  }

  return best.value;
}

/**
 * Score a string based on how likely it is to be the main content.
 */
function scoreContent(value: string, key?: string): number {
  let score = 0;

  // Length bonus (logarithmic to avoid huge strings dominating)
  score += Math.log10(value.length + 1) * 10;

  // Markdown indicators
  if (looksLikeMarkdown(value)) {
    score += 50;
  }

  // Key name hints
  const contentKeys = ["value", "content", "text", "body", "message", "result"];
  if (key && contentKeys.includes(key.toLowerCase())) {
    score += 30;
  }

  // Penalty for keys that suggest metadata
  const metadataKeys = ["id", "type", "mime", "mimeType", "$mid", "kind"];
  if (key && metadataKeys.includes(key.toLowerCase())) {
    score -= 50;
  }

  // Penalty for strings that look like IDs or paths
  if (/^[a-f0-9-]{20,}$/i.test(value)) {
    score -= 40; // UUID-like
  }
  if (/^(file|https?):\/\//.test(value)) {
    score -= 20; // URL
  }

  return score;
}

/**
 * Heuristically detect if a string looks like markdown content.
 */
function looksLikeMarkdown(text: string): boolean {
  // Check for common markdown patterns
  const patterns = [
    /^#{1,6}\s+\S/m, // Headers: # Header
    /^```[\s\S]*?```/m, // Code blocks
    /^[-*+]\s+\S/m, // Unordered lists
    /^\d+\.\s+\S/m, // Ordered lists
    /\[.+?\]\(.+?\)/, // Links: [text](url)
    /^\s*>\s+\S/m, // Blockquotes
    /\*\*.+?\*\*/, // Bold
    /`.+?`/, // Inline code
    /^\|.+\|$/m, // Tables
  ];

  let matches = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      matches++;
    }
  }

  // Consider it markdown if it has 2+ patterns or is long with 1 pattern
  return matches >= 2 || (matches >= 1 && text.length > 200);
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
      ["Format", format],
    ]);

    output += renderHeader("Content", 3);
    if (format === "markdown") {
      // Render markdown directly (it will be rendered by the preview)
      output += content + "\n\n";
    } else if (format === "json") {
      output += "```json\n" + content + "\n```\n\n";
    } else {
      // Plain text — use code fence to preserve formatting
      output += "```\n" + content + "\n```\n\n";
    }
  } else {
    output += renderHeader("Response", 2);
    output += "*No result captured (tool may still be executing)*\n\n";
  }

  return output;
}
