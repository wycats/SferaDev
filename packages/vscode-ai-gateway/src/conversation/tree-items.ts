/**
 * Tree item classes for the conversation-centric agent tree.
 *
 * Each class wraps a data model type from conversation/types.ts
 * and produces a VS Code TreeItem for display.
 */

import * as vscode from "vscode";
import type {
  ActivityLogEntry,
  AIResponseEntry,
  CompactionEntry,
  Conversation,
  ErrorEntry,
  Subagent,
  ToolCallChild,
  UserMessageEntry,
} from "@vercel/conversation";
import type { TurnEntry } from "./types.js";
import { formatTokens } from "../tokens/display.js";
import { inspectorUri } from "../inspector/uri.js";
import { summarizeToolArgs, toolIcon } from "./tool-labels.js";

// ── UserMessageItem ──────────────────────────────────────────────────

/**
 * A child entry that can be nested under a UserMessageItem.
 * Includes AI responses and errors.
 */
export type UserMessageChild =
  | { type: "ai-response"; entry: AIResponseEntry; toolCalls: ToolCallChild[] }
  | { type: "error"; entry: ErrorEntry };

/**
 * Tree item for an actual user message in the activity log.
 *
 * In the user-message-centric structure, actual user messages are collapsible
 * parents containing ALL subsequent activity until the next actual user message:
 * AI responses and errors.
 *
 * ▼ "How do I fix the bug..."              #42 · +0.3k
 *     ├─ $(chat-sparkle) Read the logs     #42 · read_file · +0.5k
 *     ├─ $(chat-sparkle) Found the issue   #43 · grep_search · +0.8k
 *     └─ $(chat-sparkle) Fixed the bug     #44 · replace_string_in_file · +1.2k
 *
 * Label: preview text or "Message #N".
 * Description: "#N · +Xk".
 * Icon: $(feedback).
 *
 * NOTE: Tool continuations are not displayed in the tree.
 */
export class UserMessageItem extends vscode.TreeItem {
  readonly entry: UserMessageEntry;
  readonly conversationId: string;
  /** All children: AI responses and tool continuations until next actual user message */
  readonly children: UserMessageChild[];

  constructor(
    entry: UserMessageEntry,
    conversationId: string,
    children: UserMessageChild[] = [],
    hasError = false,
  ) {
    const preview = entry.preview?.trim();

    const label =
      preview && preview.length > 0
        ? preview
        : `Message #${entry.sequenceNumber.toString()}`;

    // Collapsible if there are children to show
    const collapsibleState =
      children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None;

    super(label, collapsibleState);

    this.entry = entry;
    this.conversationId = conversationId;
    this.children = children;
    this.contextValue = "user-message";
    this.description = UserMessageItem.formatDescription(entry, hasError);

    this.iconPath = new vscode.ThemeIcon(
      "feedback",
      new vscode.ThemeColor(
        hasError ? "errorForeground" : "descriptionForeground",
      ),
    );

    this.command = {
      command: "vercel.ai.inspectNode",
      title: "Inspect Node",
      arguments: [
        inspectorUri(conversationId, "user-message", entry.sequenceNumber),
      ],
    };
  }

  private static formatDescription(
    entry: UserMessageEntry,
    hasError = false,
  ): string {
    const parts: string[] = [];

    // Show #N if we have a preview (otherwise it's redundant with label)
    if (entry.preview && entry.preview.trim().length > 0) {
      parts.push(`#${entry.sequenceNumber.toString()}`);
    }

    if (entry.tokenContribution !== undefined && entry.tokenContribution > 0) {
      parts.push(`+${formatTokens(entry.tokenContribution)}`);
    }

    if (hasError) {
      parts.push("⚠ error");
    }

    return parts.join(" · ");
  }
}

// ── ToolContinuationItem ─────────────────────────────────────────────

/**
 * Tree item for a tool continuation (tool results sent back to the AI).
 *
 * Tool continuations are children of UserMessageItem, showing which tools
 * returned results. They are NOT collapsible parents themselves.
 *
 * Label: tool names (e.g., "read_file, grep_search") or "Tools #N".
 * Description: "#N · +Xk".
 * Icon: $(tools).
 */
export class ToolContinuationItem extends vscode.TreeItem {
  readonly entry: UserMessageEntry;
  readonly conversationId: string;

  constructor(
    entry: UserMessageEntry,
    conversationId: string,
    /** Tools that returned results (from the previous AI response's toolsUsed) */
    tools: string[],
  ) {
    const label = ToolContinuationItem.formatLabel(entry.sequenceNumber, tools);

    super(label, vscode.TreeItemCollapsibleState.None);

    this.entry = entry;
    this.conversationId = conversationId;
    this.contextValue = "tool-continuation";
    this.description = ToolContinuationItem.formatDescription(entry);

    this.iconPath = new vscode.ThemeIcon(
      "tools",
      new vscode.ThemeColor("descriptionForeground"),
    );

    this.command = {
      command: "vercel.ai.inspectNode",
      title: "Inspect Node",
      arguments: [
        inspectorUri(conversationId, "tool-continuation", entry.sequenceNumber),
      ],
    };
  }

  private static formatLabel(sequenceNumber: number, tools: string[]): string {
    if (tools.length === 0) {
      return `Tools #${sequenceNumber.toString()}`;
    }

    // Show up to 3 tool names, abbreviated if more
    const maxTools = 3;
    if (tools.length <= maxTools) {
      return tools.join(", ");
    }
    return `${tools.slice(0, maxTools).join(", ")}+${(tools.length - maxTools).toString()}`;
  }

  private static formatDescription(entry: UserMessageEntry): string {
    const parts: string[] = [];

    parts.push(`#${entry.sequenceNumber.toString()}`);

    if (entry.tokenContribution !== undefined && entry.tokenContribution > 0) {
      parts.push(`+${formatTokens(entry.tokenContribution)}`);
    }

    return parts.join(" · ");
  }
}

// ── ToolCallItem ────────────────────────────────────────────────────

/**
 * Tree item for a tool call made by an AI response.
 *
 * Tool calls are non-collapsible leaf nodes nested under AIResponseItem,
 * showing what tools were invoked during the response.
 *
 * Label: "read_file /src/foo.ts" (tool name + args preview).
 * Description: "#<callId prefix>".
 * Icon: $(wrench).
 */
export class ToolCallItem extends vscode.TreeItem {
  readonly callId: string;
  readonly name: string;
  readonly args: Record<string, unknown>;

  constructor(callId: string, name: string, args: Record<string, unknown>) {
    const argSummary = summarizeToolArgs(name, args);
    const label = argSummary ? `${name} ${argSummary}` : name;

    super(label, vscode.TreeItemCollapsibleState.None);

    this.callId = callId;
    this.name = name;
    this.args = args;
    this.contextValue = "tool-call";
    this.description = `#${callId.slice(0, 8)}`;

    this.iconPath = new vscode.ThemeIcon(
      toolIcon(name),
      new vscode.ThemeColor("descriptionForeground"),
    );

    // Non-interactive: no command
  }
}

// ── AIResponseItem ───────────────────────────────────────────────────

/** How long to show spinner for pending characterization (ms) */
const AI_RESPONSE_CHARACTERIZATION_TIMEOUT_MS = 10_000;

/**
 * Tree item for an AI response in the activity log.
 *
 * Label: characterization or "Response #N".
 * Description: "#N · +Xk".
 * Icon: $(chat-sparkle) by default, $(loading~spin) if streaming,
 *       $(sync~spin) if pending characterization (within timeout window).
 */
export class AIResponseItem extends vscode.TreeItem {
  readonly entry: AIResponseEntry;
  readonly conversationId: string;
  readonly toolCalls: ToolCallChild[];
  readonly subagents: Subagent[];

  constructor(
    entry: AIResponseEntry,
    conversationId: string,
    subagents: Subagent[],
    toolCalls: ToolCallChild[] = [],
  ) {
    const hasChildren = subagents.length > 0 || toolCalls.length > 0;
    const collapsibleState = hasChildren
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const label = AIResponseItem.getLabel(entry);

    super(label, collapsibleState);

    this.entry = entry;
    this.conversationId = conversationId;
    this.toolCalls = toolCalls;
    this.subagents = subagents;
    this.contextValue = "ai-response";
    this.description = AIResponseItem.formatDescription(entry);
    this.iconPath = AIResponseItem.getIcon(entry);

    this.command = {
      command: "vercel.ai.inspectNode",
      title: "Inspect Node",
      arguments: [
        inspectorUri(conversationId, "ai-response", entry.sequenceNumber),
      ],
    };
  }

  private static isPendingWithinTimeout(entry: AIResponseEntry): boolean {
    return (
      entry.state === "pending-characterization" &&
      Date.now() - entry.timestamp < AI_RESPONSE_CHARACTERIZATION_TIMEOUT_MS
    );
  }

  private static getLabel(entry: AIResponseEntry): string {
    if (entry.state === "interrupted") {
      return `#${entry.sequenceNumber.toString()} (interrupted)`;
    }

    if (entry.characterization) {
      return entry.characterization;
    }

    // Pending characterization - show ellipsis to indicate "thinking"
    if (AIResponseItem.isPendingWithinTimeout(entry)) {
      return `#${entry.sequenceNumber.toString()} ⋯`;
    }

    return `Response #${entry.sequenceNumber.toString()}`;
  }

  private static formatDescription(entry: AIResponseEntry): string {
    const parts: string[] = [];

    // Only show sequence number if we have a characterization (otherwise redundant)
    if (entry.characterization) {
      parts.push(`#${entry.sequenceNumber.toString()}`);
    }

    // Show tools used (abbreviated if many)
    if (entry.toolsUsed && entry.toolsUsed.length > 0) {
      const maxTools = 3;
      const toolsDisplay =
        entry.toolsUsed.length <= maxTools
          ? entry.toolsUsed.join(", ")
          : `${entry.toolsUsed.slice(0, maxTools).join(", ")}+${(entry.toolsUsed.length - maxTools).toString()}`;
      parts.push(toolsDisplay);
    }

    if (entry.tokenContribution > 0) {
      parts.push(`+${formatTokens(entry.tokenContribution)}`);
    }

    return parts.join(" · ");
  }

  private static getIcon(entry: AIResponseEntry): vscode.ThemeIcon {
    if (entry.state === "streaming") {
      return new vscode.ThemeIcon(
        "loading~spin",
        new vscode.ThemeColor("charts.yellow"),
      );
    }

    // Pending characterization within timeout - use muted sparkle (no spinner)
    if (AIResponseItem.isPendingWithinTimeout(entry)) {
      return new vscode.ThemeIcon(
        "chat-sparkle",
        new vscode.ThemeColor("descriptionForeground"),
      );
    }

    if (entry.state === "interrupted") {
      return new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("problemsWarningIcon.foreground"),
      );
    }

    return new vscode.ThemeIcon("chat-sparkle");
  }
}

// ── TurnItem ─────────────────────────────────────────────────────────

/**
 * Tree item for a user↔assistant turn in the activity log.
 *
 * Label: characterization (e.g., "Refactored auth middleware") or "Turn N".
 * Description: "2.1k out" or "streaming..." or "2.1k out · 1 subagent".
 * Icon: $(comment-discussion) for plain turns, $(type-hierarchy) for turns
 *       with subagents, $(loading~spin) for streaming turns,
 *       $(sync~spin) for turns awaiting characterization.
 */
/** How long to show "summarizing..." indicator after turn completion (ms) */
const CHARACTERIZATION_PENDING_WINDOW_MS = 10_000;

/** Legacy TurnItem for backward compatibility. */
export class TurnItem extends vscode.TreeItem {
  readonly turn: TurnEntry;
  readonly conversationId: string;

  constructor(turn: TurnEntry, conversationId: string, subagents: Subagent[]) {
    const hasSubagents = subagents.length > 0;
    const collapsibleState = hasSubagents
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;

    // Show "summarizing..." only for recently completed turns without characterization
    // After the window expires, just show "Turn N" without the spinner
    const isRecentlyCompleted =
      Date.now() - turn.timestamp < CHARACTERIZATION_PENDING_WINDOW_MS;
    const isPendingCharacterization =
      !turn.streaming &&
      !turn.characterization &&
      turn.outputTokens > 0 &&
      isRecentlyCompleted;
    const label = turn.characterization ?? `Turn ${turn.turnNumber.toString()}`;
    super(label, collapsibleState);

    this.turn = turn;
    this.conversationId = conversationId;
    this.contextValue = "turn";
    this.description = TurnItem.formatDescription(
      turn,
      subagents,
      isPendingCharacterization,
    );
    this.iconPath = TurnItem.getIcon(
      turn,
      hasSubagents,
      isPendingCharacterization,
    );

    this.command = {
      command: "vercel.ai.inspectNode",
      title: "Inspect Node",
      arguments: [inspectorUri(conversationId, "turn", turn.turnNumber)],
    };
  }

  private static formatDescription(
    turn: TurnEntry,
    subagents: Subagent[],
    isPendingCharacterization: boolean,
  ): string {
    if (turn.streaming) {
      return "streaming...";
    }

    const parts: string[] = [];

    // Show "summarizing..." indicator when characterization is pending
    if (isPendingCharacterization) {
      parts.push("summarizing...");
    }

    if (turn.outputTokens > 0) {
      // Use + prefix to indicate tokens added to context
      parts.push(`+${formatTokens(turn.outputTokens)} out`);
    }
    if (subagents.length === 1) {
      parts.push("1 subagent");
    } else if (subagents.length > 1) {
      parts.push(`${subagents.length.toString()} subagents`);
    }
    return parts.join(" · ");
  }

  private static getIcon(
    turn: TurnEntry,
    hasSubagents: boolean,
    isPendingCharacterization: boolean,
  ): vscode.ThemeIcon {
    if (turn.streaming) {
      return new vscode.ThemeIcon(
        "loading~spin",
        new vscode.ThemeColor("charts.yellow"),
      );
    }
    // Show sync spinner when characterization is pending
    if (isPendingCharacterization) {
      return new vscode.ThemeIcon(
        "sync~spin",
        new vscode.ThemeColor("descriptionForeground"),
      );
    }
    if (hasSubagents) {
      return new vscode.ThemeIcon("type-hierarchy");
    }
    return new vscode.ThemeIcon("comment-discussion");
  }
}

// ── CompactionItem ───────────────────────────────────────────────────

/**
 * Tree item for a compaction event in the activity log.
 *
 * Label: "↓ Compacted 30k (turn 8)" or "↓ Context managed 5k (turn 3)".
 * Icon: $(fold-down).
 */
export class CompactionTreeItem extends vscode.TreeItem {
  readonly entry: CompactionEntry;
  readonly conversationId: string;

  constructor(entry: CompactionEntry, conversationId: string) {
    const verb =
      entry.compactionType === "summarization"
        ? "Compacted"
        : "Context managed";
    const label = `↓ ${verb} ${formatTokens(entry.freedTokens)} (turn ${entry.turnNumber.toString()})`;

    super(label, vscode.TreeItemCollapsibleState.None);

    this.entry = entry;
    this.conversationId = conversationId;
    this.contextValue = "compaction";
    this.iconPath = new vscode.ThemeIcon(
      "fold-down",
      new vscode.ThemeColor("descriptionForeground"),
    );

    this.command = {
      command: "vercel.ai.inspectNode",
      title: "Inspect Node",
      arguments: [inspectorUri(conversationId, "compaction", entry.turnNumber)],
    };

    if (entry.details) {
      this.tooltip = entry.details;
    }
  }
}

// ── ErrorItem ────────────────────────────────────────────────────────

/**
 * Tree item for an error in the activity log.
 *
 * Label: "✗ Error: <message>" (truncated to 60 chars).
 * Icon: $(error).
 */
export class ErrorTreeItem extends vscode.TreeItem {
  readonly entry: ErrorEntry;
  readonly conversationId: string;

  constructor(entry: ErrorEntry, conversationId: string) {
    const truncatedMessage =
      entry.message.length > 60
        ? entry.message.slice(0, 57) + "..."
        : entry.message;
    const label = `✗ ${truncatedMessage}`;

    super(label, vscode.TreeItemCollapsibleState.None);

    this.entry = entry;
    this.conversationId = conversationId;
    this.contextValue = "error";
    this.iconPath = new vscode.ThemeIcon(
      "error",
      new vscode.ThemeColor("errorForeground"),
    );

    const identifier = entry.turnNumber ?? entry.timestamp;
    this.command = {
      command: "vercel.ai.inspectNode",
      title: "Inspect Node",
      arguments: [inspectorUri(conversationId, "error", identifier)],
    };

    // Full message in tooltip
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Error**\n\n${entry.message}`);
    if (entry.turnNumber != null) {
      md.appendMarkdown(`\n\n*At turn ${entry.turnNumber.toString()}*`);
    }
    this.tooltip = md;
  }
}

// ── ConversationItem ─────────────────────────────────────────────────

/** Maximum non-error entries shown in the windowed activity log. */
const WINDOW_SIZE = 20;

/**
 * Tree item for a top-level conversation.
 *
 * Label: AI-generated title or first message preview or model name.
 * Description: "45k/128k · 35%" or "streaming..." or raw token count.
 * Icon: status-aware (streaming spinner, error, utilization-colored check).
 */
export class ConversationItem extends vscode.TreeItem {
  readonly conversation: Conversation;

  constructor(conversation: Conversation) {
    super(conversation.title, vscode.TreeItemCollapsibleState.Expanded);

    this.conversation = conversation;
    this.contextValue = "conversation";
    this.description = ConversationItem.formatDescription(conversation);
    this.iconPath = ConversationItem.getIcon(conversation);
    this.tooltip = ConversationItem.formatTooltip(conversation);

    this.command = {
      command: "vercel.ai.inspectNode",
      title: "Inspect Node",
      arguments: [inspectorUri(conversation.id, "conversation")],
    };
  }

  private static formatDescription(conversation: Conversation): string {
    if (conversation.status === "active" && conversation.tokens.input === 0) {
      return "streaming...";
    }

    const tokens = formatTokens(conversation.tokens.input);

    if (conversation.tokens.maxInput > 0) {
      const max = formatTokens(conversation.tokens.maxInput);
      const pct = Math.round(
        (conversation.tokens.input / conversation.tokens.maxInput) * 100,
      );
      return `${tokens}/${max} · ${pct.toString()}%`;
    }

    return tokens;
  }

  private static getIcon(conversation: Conversation): vscode.ThemeIcon {
    // Check if actively streaming (has a response in streaming state)
    const isStreaming = conversation.activityLog.some(
      (entry) => entry.type === "ai-response" && entry.state === "streaming",
    );

    if (isStreaming) {
      // Actively streaming - show spinner
      return new vscode.ThemeIcon(
        "loading~spin",
        new vscode.ThemeColor("charts.yellow"),
      );
    }

    if (conversation.status === "active") {
      // Active but not streaming - show "live" indicator without spinner
      return new vscode.ThemeIcon(
        "circle-filled",
        new vscode.ThemeColor("charts.green"),
      );
    }

    // Check context utilization for color
    if (conversation.tokens.maxInput > 0 && conversation.tokens.input > 0) {
      const pct = conversation.tokens.input / conversation.tokens.maxInput;
      if (pct > 0.9) {
        return new vscode.ThemeIcon(
          "comment-discussion",
          new vscode.ThemeColor("charts.red"),
        );
      }
      if (pct > 0.7) {
        return new vscode.ThemeIcon(
          "comment-discussion",
          new vscode.ThemeColor("charts.orange"),
        );
      }
    }

    return new vscode.ThemeIcon(
      "comment-discussion",
      new vscode.ThemeColor("charts.green"),
    );
  }

  private static formatTooltip(
    conversation: Conversation,
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    md.appendMarkdown(`### ${conversation.title}\n\n`);
    md.appendMarkdown(`**Model:** ${conversation.modelId}\n\n`);
    md.appendMarkdown(`**Status:** ${conversation.status}\n\n`);

    if (conversation.turnCount > 0) {
      md.appendMarkdown(`**Turns:** ${conversation.turnCount.toString()}\n\n`);
    }

    if (conversation.tokens.input > 0) {
      md.appendMarkdown(
        `**Input:** ${conversation.tokens.input.toLocaleString()} tokens\n\n`,
      );
    }

    if (conversation.totalOutputTokens > 0) {
      md.appendMarkdown(
        `**Total Output:** ${conversation.totalOutputTokens.toLocaleString()} tokens\n\n`,
      );
    }

    if (conversation.tokens.maxInput > 0) {
      md.appendMarkdown(
        `**Max Input:** ${conversation.tokens.maxInput.toLocaleString()} tokens\n\n`,
      );
    }

    return md;
  }

  /**
   * Window the activity log for display as children.
   *
   * Returns the most recent entries following the windowing rule:
   * - Up to WINDOW_SIZE (20) most recent **actual user messages**
   *   (user-message entries where isToolContinuation !== true)
   * - All entries belonging to the same user message group are kept together
   *   (AI responses, tool continuations, etc.)
   * - Errors and compactions are shown alongside their chronological neighbors
   * - When an error falls outside the window, it moves to History
   *
   * @returns Object with `windowed` (visible entries), `history`
   *          (older entries), and `hasHistory` (whether history exists).
   */
  static windowActivityLog(log: ActivityLogEntry[]): {
    windowed: ActivityLogEntry[];
    history: ActivityLogEntry[];
    hasHistory: boolean;
  } {
    if (log.length === 0) {
      return { windowed: [], history: [], hasHistory: false };
    }

    // First pass: count actual user messages to find the cutoff point
    // We want to include the N most recent actual user messages and all
    // entries that belong to their groups (AI responses, tool continuations)
    let actualUserMessageCount = 0;
    let cutoffIndex = -1; // Index of the first entry to exclude (in chronological order)

    // Helper to check if an entry is an actual user message (not a tool continuation)
    const isActualUserMessage = (entry: ActivityLogEntry): boolean =>
      entry.type === "user-message" && !entry.isToolContinuation;

    // Process chronologically to find where to cut
    for (const entry of log) {
      if (isActualUserMessage(entry)) {
        actualUserMessageCount++;
      }
    }

    // If we have more than WINDOW_SIZE actual user messages, find the cutoff
    if (actualUserMessageCount > WINDOW_SIZE) {
      // We need to exclude the oldest (actualUserMessageCount - WINDOW_SIZE) user messages
      // and all entries that belong to their groups
      const toExclude = actualUserMessageCount - WINDOW_SIZE;
      let excludedCount = 0;

      for (let i = 0; i < log.length; i++) {
        const entry = log.at(i);
        if (!entry) continue;
        if (isActualUserMessage(entry)) {
          excludedCount++;
          if (excludedCount === toExclude) {
            // Find the end of this user message's group (next actual user message or end)
            cutoffIndex = i + 1;
            while (cutoffIndex < log.length) {
              const nextEntry = log.at(cutoffIndex);
              if (!nextEntry || isActualUserMessage(nextEntry)) {
                break;
              }
              cutoffIndex++;
            }
            break;
          }
        }
      }
    }

    // Second pass: split into windowed and history
    // Both are returned in chronological order (same as input).
    // The grouping function handles reverse-chrono display.
    if (cutoffIndex === -1) {
      // All entries fit in the window
      return { windowed: [...log], history: [], hasHistory: false };
    }

    const history = log.slice(0, cutoffIndex);
    const windowed = log.slice(cutoffIndex);

    return { windowed, history, hasHistory: history.length > 0 };
  }
}

// ── HistoryItem ──────────────────────────────────────────────────────

/**
 * Tree item for a per-conversation "History (N earlier entries)" node.
 *
 * Shows as a collapsed node under a conversation, containing activity
 * log entries that were trimmed by the 5-entry windowing rule.
 *
 * Label: "History (N earlier entries)" or "History (1 earlier entry)".
 * Icon: $(history).
 */
export class HistoryItem extends vscode.TreeItem {
  readonly entries: ActivityLogEntry[];
  readonly conversationId: string;

  constructor(entries: ActivityLogEntry[], conversationId: string) {
    const count = entries.length;
    const noun = count === 1 ? "entry" : "entries";
    const label = `History (${count.toString()} earlier ${noun})`;

    super(label, vscode.TreeItemCollapsibleState.Collapsed);

    this.entries = entries;
    this.conversationId = conversationId;
    this.contextValue = "history";
    // Stable ID preserves expansion state across tree refreshes
    this.id = `history:${conversationId}`;
    this.iconPath = new vscode.ThemeIcon(
      "history",
      new vscode.ThemeColor("descriptionForeground"),
    );

    this.command = {
      command: "vercel.ai.inspectNode",
      title: "Inspect Node",
      arguments: [inspectorUri(conversationId, "history")],
    };
  }
}

// ── SubagentItem ─────────────────────────────────────────────────────

/**
 * Tree item for a subagent nested under a spawning turn.
 *
 * Label: subagent name (e.g., "recon", "execute").
 * Description: "8k · complete" or "streaming..." or "error".
 * Icon: status-dependent (spinner, check, error) with color.
 * Collapsible if the subagent has children (nested subagents).
 */
export class SubagentItem extends vscode.TreeItem {
  readonly subagent: Subagent;
  readonly conversationId: string;

  constructor(subagent: Subagent, conversationId: string) {
    const collapsibleState =
      subagent.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;

    super(subagent.name, collapsibleState);

    this.subagent = subagent;
    this.conversationId = conversationId;
    this.contextValue = "subagent";
    this.description = SubagentItem.formatDescription(subagent);
    this.iconPath = SubagentItem.getIcon(subagent);

    this.command = {
      command: "vercel.ai.inspectNode",
      title: "Inspect Node",
      arguments: [
        inspectorUri(conversationId, "subagent", subagent.conversationId),
      ],
    };
  }

  private static formatDescription(subagent: Subagent): string {
    if (subagent.status === "streaming") {
      return "streaming...";
    }

    const totalTokens = subagent.tokens.input + subagent.tokens.output;
    const tokenStr = totalTokens > 0 ? formatTokens(totalTokens) : "";

    if (subagent.status === "error") {
      return tokenStr ? `${tokenStr} · error` : "error";
    }

    return tokenStr ? `${tokenStr} · complete` : "complete";
  }

  private static getIcon(subagent: Subagent): vscode.ThemeIcon {
    switch (subagent.status) {
      case "streaming":
        return new vscode.ThemeIcon(
          "loading~spin",
          new vscode.ThemeColor("charts.yellow"),
        );
      case "error":
        return new vscode.ThemeIcon(
          "error",
          new vscode.ThemeColor("errorForeground"),
        );
      case "complete":
        return new vscode.ThemeIcon(
          "check",
          new vscode.ThemeColor("charts.green"),
        );
    }
  }

  /**
   * Resolve subagent IDs from an AI response (or legacy turn) to their
   * Subagent objects by searching the hierarchy depth-first.
   */
  static resolveSubagents(
    subagentIds: string[],
    allSubagents: Subagent[],
  ): Subagent[] {
    if (subagentIds.length === 0) {
      return [];
    }

    const idSet = new Set(subagentIds);
    const found: Subagent[] = [];

    function search(subagents: Subagent[]): void {
      for (const sub of subagents) {
        if (idSet.has(sub.conversationId)) {
          found.push(sub);
        }
        if (sub.children.length > 0) {
          search(sub.children);
        }
      }
    }

    search(allSubagents);
    return found;
  }
}

// ── SectionHeaderItem ────────────────────────────────────────────────

/**
 * Tree item for the top-level "History" section header.
 *
 * Groups idle and archived conversations that have moved out of the
 * active root. Active conversations appear at root with no header;
 * only the History section gets a header.
 *
 * Label: "History".
 * Icon: $(archive).
 */
export class SectionHeaderItem extends vscode.TreeItem {
  readonly conversations: Conversation[];

  constructor(conversations: Conversation[]) {
    super("History", vscode.TreeItemCollapsibleState.Collapsed);

    this.conversations = conversations;
    this.contextValue = "sectionHeader";
    this.iconPath = new vscode.ThemeIcon(
      "archive",
      new vscode.ThemeColor("descriptionForeground"),
    );
  }

  /**
   * Partition conversations into active (shown at root) and
   * history (shown under the History section header).
   *
   * Root = status "active" or "idle".
   * History = status "archived".
   */
  static partitionConversations(conversations: Conversation[]): {
    active: Conversation[];
    history: Conversation[];
  } {
    const active: Conversation[] = [];
    const history: Conversation[] = [];

    for (const conv of conversations) {
      if (conv.status === "active" || conv.status === "idle") {
        active.push(conv);
      } else {
        history.push(conv);
      }
    }

    return { active, history };
  }
}
