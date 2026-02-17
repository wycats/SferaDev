/**
 * Pure, dependency-free tree builder for the activity log.
 *
 * This module extracts the grouping and windowing logic into pure functions
 * that operate on plain data types. It is the System Under Test (SUT) for
 * property-based tests that verify the tree's structural invariants.
 *
 * See docs/activity-tree-properties.md for the full specification.
 */

import type {
  ActivityLogEntry,
  AIResponseEntry,
  CompactionEntry,
  ErrorEntry,
  UserMessageEntry,
} from "./types.ts";

// ── Tree Node Types ──────────────────────────────────────────────────

/** A child of a user-message node in the tree. */
export type TreeChild =
  | {
      kind: "ai-response";
      entry: AIResponseEntry;
      tools: string[];
      toolCalls: ToolCallChild[];
    }
  | { kind: "error"; entry: ErrorEntry };

/** A tool call nested under an AI response. */
export interface ToolCallChild {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

/** A top-level node in the activity tree. */
export type TreeNode =
  | {
      kind: "user-message";
      entry: UserMessageEntry;
      children: TreeChild[];
      /** True if any child is an error entry. */
      hasError: boolean;
    }
  | { kind: "compaction"; entry: CompactionEntry }
  | { kind: "error"; entry: ErrorEntry }
  | { kind: "history"; count: number };

/** Result of building the full tree from an activity log. */
export interface TreeResult {
  /** Visible top-level nodes (reverse chronological). */
  topLevel: TreeNode[];
  /** Entries that were windowed out. */
  historyEntries: ActivityLogEntry[];
}

// ── Constants ────────────────────────────────────────────────────────

/** Maximum number of actual user messages shown in the windowed view. */
export const WINDOW_SIZE = 20;

// ── Helpers ──────────────────────────────────────────────────────────

/** Check if an entry is an actual user message (not a tool continuation). */
export function isActualUserMessage(
  entry: ActivityLogEntry,
): entry is UserMessageEntry {
  return entry.type === "user-message" && !entry.isToolContinuation;
}

// ── Windowing ────────────────────────────────────────────────────────

/**
 * Split a chronological activity log into windowed (visible) and history
 * (older) entries. The window contains the most recent WINDOW_SIZE actual
 * user messages and ALL entries that belong to their groups.
 *
 * Group atomicity: if a user message is in the window, all of its children
 * (AI responses, tool continuations) are too. The cut happens at the
 * boundary between two user message groups.
 */
export function windowActivityLog(log: ActivityLogEntry[]): {
  windowed: ActivityLogEntry[];
  history: ActivityLogEntry[];
} {
  if (log.length === 0) {
    return { windowed: [], history: [] };
  }

  // Count actual user messages
  let actualUserMessageCount = 0;
  for (const entry of log) {
    if (isActualUserMessage(entry)) {
      actualUserMessageCount++;
    }
  }

  // If within window, everything is visible
  if (actualUserMessageCount <= WINDOW_SIZE) {
    return { windowed: [...log], history: [] };
  }

  // Find the cutoff: exclude the oldest N user message groups
  const toExclude = actualUserMessageCount - WINDOW_SIZE;
  let excludedCount = 0;
  let cutoffIndex = log.length; // default: everything in window

  for (let i = 0; i < log.length; i++) {
    const entry = log.at(i);
    if (!entry) continue;
    if (isActualUserMessage(entry)) {
      excludedCount++;
      if (excludedCount === toExclude) {
        // Find the end of this user message's group
        // (next actual user message or end of log)
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

  return {
    windowed: log.slice(cutoffIndex),
    history: log.slice(0, cutoffIndex),
  };
}

// ── Grouping ─────────────────────────────────────────────────────────

/** Internal representation of a user message group during construction. */
interface UserMessageGroup {
  userMessage: UserMessageEntry;
  children: TreeChild[];
  /** Index of the user message in the original entry array (for ordering). */
  sourceIndex: number;
}

/**
 * Group a chronological list of activity log entries into user-message-centric
 * tree nodes.
 *
 * Rules:
 * - Each actual user message (isToolContinuation !== true) starts a new group.
 * - AI responses accumulate into the current group.
 * - Tool continuations are ignored (their tokens are attributed to AI responses).
 * - Errors nest as children of the current user message group (with hasError flag).
 * - Errors before any user message are orphan errors (shown flat — degenerate case).
 * - Compaction entries are always top-level flat nodes (boundary markers between eras).
 * - AI responses before any user message are orphans (shown flat — degenerate case).
 */
export function groupByUserMessage(entries: ActivityLogEntry[]): TreeNode[] {
  // Sort entries so that within the same sequence number, user messages come
  // before AI responses. The streaming branch in the manager creates the AI
  // response before the user message (it streams first, then turnCount
  // increments and the user message is created). Without this sort, the AI
  // response gets consumed by the *previous* user message group instead of
  // the new one.
  //
  // Only user-message and ai-response entries have sequenceNumber; compaction
  // and error entries use turnNumber (or none). We preserve original order for
  // entries without sequenceNumber.
  const getSeq = (e: ActivityLogEntry): number | undefined => {
    if (e.type === "user-message" || e.type === "ai-response") {
      return e.sequenceNumber;
    }
    return undefined;
  };

  const sorted = [...entries].sort((a, b) => {
    const seqA = getSeq(a);
    const seqB = getSeq(b);
    // If either lacks a sequence number, preserve original order
    if (seqA === undefined || seqB === undefined) return 0;
    // Different sequence numbers: preserve original order
    if (seqA !== seqB) return 0;
    // Same sequence number: sort by type priority
    const rank = (e: ActivityLogEntry): number => {
      if (e.type === "user-message" && !e.isToolContinuation) return 0;
      if (e.type === "ai-response") return 1;
      if (e.type === "user-message" && e.isToolContinuation) return 2;
      return 3; // error, compaction (shouldn't reach here due to getSeq check)
    };
    return rank(a) - rank(b);
  });

  const groups: UserMessageGroup[] = [];
  let currentGroup: UserMessageGroup | null = null;
  let lastAIResponseTools: string[] = [];

  // Flat entries (compaction + orphan errors) with their original index for ordering
  const flatEntries: {
    entry: CompactionEntry | ErrorEntry;
    sourceIndex: number;
  }[] = [];

  // Orphan AI responses (before any user message)
  const orphanResponses: { entry: AIResponseEntry; sourceIndex: number }[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted.at(i);
    if (!entry) continue;

    if (entry.type === "user-message") {
      if (entry.isToolContinuation) {
        // Tool continuations are invisible in the tree.
        // Their token contributions are absorbed into the AI response.
        // Just reset tools tracking.
        lastAIResponseTools = [];
      } else {
        // Actual user message: start a new group
        if (currentGroup) {
          groups.push(currentGroup);
        }
        currentGroup = { userMessage: entry, children: [], sourceIndex: i };
        lastAIResponseTools = [];
      }
    } else if (entry.type === "ai-response") {
      // Track tools for the next tool continuation
      lastAIResponseTools = entry.toolsUsed ?? [];

      if (currentGroup) {
        const toolCallChildren: ToolCallChild[] = (entry.toolCalls ?? []).map(
          (toolCall) => ({
            callId: toolCall.callId,
            name: toolCall.name,
            args: toolCall.args,
          }),
        );
        // Add the AI response with nested tool calls
        currentGroup.children.push({
          kind: "ai-response",
          entry,
          tools: [...lastAIResponseTools],
          toolCalls: toolCallChildren,
        });
      } else {
        orphanResponses.push({ entry, sourceIndex: i });
      }
    } else if (entry.type === "error") {
      // Errors nest into the current user message group
      if (currentGroup) {
        currentGroup.children.push({ kind: "error", entry });
      } else {
        // Orphan error (before any user message) — keep flat
        flatEntries.push({ entry, sourceIndex: i });
      }
    } else {
      // compaction — always flat (boundary marker between eras)
      flatEntries.push({ entry, sourceIndex: i });
    }
  }

  // Don't forget the last group
  if (currentGroup) {
    groups.push(currentGroup);
  }

  // Build the output: interleave groups and flat entries in reverse chronological order
  // We need to merge groups and flat entries by their source position, then reverse.

  type Positioned =
    | { type: "group"; group: UserMessageGroup; sourceIndex: number }
    | {
        type: "flat";
        entry: CompactionEntry | ErrorEntry;
        sourceIndex: number;
      };

  const positioned: Positioned[] = [
    ...groups.map((g) => ({
      type: "group" as const,
      group: g,
      sourceIndex: g.sourceIndex,
    })),
    ...flatEntries.map((f) => ({
      type: "flat" as const,
      entry: f.entry,
      sourceIndex: f.sourceIndex,
    })),
  ];

  // Sort by source index descending (reverse chronological)
  positioned.sort((a, b) => b.sourceIndex - a.sourceIndex);

  const result: TreeNode[] = [];

  for (const item of positioned) {
    if (item.type === "group") {
      const hasError = item.group.children.some((c) => c.kind === "error");
      result.push({
        kind: "user-message",
        entry: item.group.userMessage,
        children: item.group.children,
        hasError,
      });
    } else if (item.entry.type === "compaction") {
      result.push({ kind: "compaction", entry: item.entry });
    } else {
      // Orphan error — flat top-level node
      result.push({ kind: "error", entry: item.entry });
    }
  }

  // Orphan AI responses are a degenerate case — we don't include them in the
  // tree node structure since they shouldn't exist in valid event streams.
  // The property tests will verify this.

  return result;
}

// ── Full Pipeline ────────────────────────────────────────────────────

/**
 * Build the complete tree from a chronological activity log.
 *
 * This is the primary SUT for property-based tests:
 *   ActivityLogEntry[] → TreeResult
 *
 * Steps:
 * 1. Window the log (split into visible + history)
 * 2. Group visible entries by user message
 * 3. Append a history node if needed
 */
export function buildTree(log: ActivityLogEntry[]): TreeResult {
  const { windowed, history } = windowActivityLog(log);
  const topLevel = groupByUserMessage(windowed);

  if (history.length > 0) {
    topLevel.push({ kind: "history", count: history.length });
  }

  return { topLevel, historyEntries: history };
}

// ── ASCII Rendering ──────────────────────────────────────────────────

/**
 * Render a TreeResult as an ASCII tree for counterexample display.
 *
 * Example output:
 * ```
 * ▼ 👤 "Fix the bug"                    #5 · +0.3k
 *     ├─ $(chat-sparkle) Investigated   #5 · read_file · +0.5k
 *     │   └─ $(wrench) read_file /src/foo.ts  #abcd1234
 *     └─ $(chat-sparkle) Fixed it       #6 · +1.2k
 * ├─ $(fold-down) Compacted 30k
 * └─ ▸ History (8 earlier entries)
 * ```
 */
export function renderTree(result: TreeResult): string {
  const lines: string[] = [];

  for (let i = 0; i < result.topLevel.length; i++) {
    const node = result.topLevel.at(i);
    if (!node) continue;
    const isLast = i === result.topLevel.length - 1;
    const prefix = isLast ? "└─ " : "├─ ";
    const childPrefix = isLast ? "    " : "│   ";

    switch (node.kind) {
      case "user-message": {
        const preview = node.entry.preview?.trim();
        const label = preview
          ? `"${preview}"`
          : `Message #${node.entry.sequenceNumber}`;
        const desc = formatDesc(
          node.entry.sequenceNumber,
          node.entry.tokenContribution,
        );
        const errorMarker = node.hasError ? " · ⚠ error" : "";
        lines.push(`▼ 👤 ${label}${desc ? `  ${desc}` : ""}${errorMarker}`);

        for (let j = 0; j < node.children.length; j++) {
          const child = node.children.at(j);
          if (!child) continue;
          const childIsLast = j === node.children.length - 1;
          const cp = childIsLast ? "└─ " : "├─ ";

          if (child.kind === "ai-response") {
            const charLabel =
              child.entry.characterization ??
              `Response #${child.entry.sequenceNumber}`;
            const toolStr =
              child.tools.length > 0 ? ` · ${child.tools.join(", ")}` : "";
            const tokenStr =
              child.entry.tokenContribution > 0
                ? ` · +${fmtTokens(child.entry.tokenContribution)}`
                : "";
            lines.push(
              `${childPrefix}${cp}$(chat-sparkle) ${charLabel}  #${child.entry.sequenceNumber}${toolStr}${tokenStr}`,
            );
            if (child.toolCalls.length > 0) {
              const toolPrefix = childPrefix + (childIsLast ? "    " : "│   ");
              for (let k = 0; k < child.toolCalls.length; k++) {
                const toolCall = child.toolCalls.at(k);
                if (!toolCall) continue;
                const toolIsLast = k === child.toolCalls.length - 1;
                const tcp = toolIsLast ? "└─ " : "├─ ";
                const argKeys = Object.keys(toolCall.args);
                let argsStr = "";
                if (argKeys.length > 0) {
                  const argPreview = argKeys
                    .slice(0, 2)
                    .map((key) => {
                      const val = toolCall.args[key];
                      if (typeof val === "string") {
                        return val.length > 20 ? `${val.slice(0, 17)}...` : val;
                      }
                      return String(val).slice(0, 15);
                    })
                    .join(" ");
                  argsStr = ` ${argPreview}`;
                }
                lines.push(
                  `${toolPrefix}${tcp}$(wrench) ${toolCall.name}${argsStr}  #${toolCall.callId.slice(0, 8)}`,
                );
              }
            }
          } else {
            // error child
            lines.push(`${childPrefix}${cp}$(error) ${child.entry.message}`);
          }
        }
        break;
      }
      case "compaction":
        lines.push(
          `${prefix}$(fold-down) Compacted ${fmtTokens(node.entry.freedTokens)}`,
        );
        break;
      case "error":
        lines.push(`${prefix}$(error) ${node.entry.message}`);
        break;
      case "history":
        lines.push(
          `${prefix}▸ History (${node.count} earlier ${node.count === 1 ? "entry" : "entries"})`,
        );
        break;
    }
  }

  return lines.join("\n");
}

function formatDesc(seq: number, tokenContribution?: number): string {
  const parts: string[] = [`#${seq}`];
  if (tokenContribution != null && tokenContribution > 0) {
    parts.push(`+${fmtTokens(tokenContribution)}`);
  }
  return parts.join(" · ");
}

function fmtTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return count.toString();
}
