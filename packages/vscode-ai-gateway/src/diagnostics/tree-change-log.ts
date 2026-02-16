/**
 * Tree Change Log - JSONL logging for conversation tree changes
 *
 * Logs every change to the conversation tree with a full snapshot,
 * enabling debugging by reviewing the sequence of changes.
 *
 * File: .logs/tree-changes.jsonl
 *
 * Each line contains:
 * - timestamp: ISO timestamp
 * - event: what changed (e.g., "CONVERSATION_ADDED", "TURN_ADDED")
 * - change: details about the specific change
 * - snapshot: full tree state after the change
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { safeJsonStringify } from "../utils/serialize.js";
import type {
  Conversation,
  ActivityLogEntry,
  Subagent,
} from "../conversation/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type TreeChangeEvent =
  | "TREE_INITIALIZED"
  | "CONVERSATION_ADDED"
  | "CONVERSATION_UPDATED"
  | "CONVERSATION_REMOVED"
  | "USER_MESSAGE_ADDED"
  | "AI_RESPONSE_ADDED"
  | "AI_RESPONSE_UPDATED"
  | "AI_RESPONSE_CHARACTERIZED"
  | "TURN_ADDED"
  | "TURN_UPDATED"
  | "TURN_CHARACTERIZED"
  | "COMPACTION_ADDED"
  | "ERROR_ADDED"
  | "SUBAGENT_ADDED"
  | "STATUS_CHANGED"
  | "TOKENS_UPDATED"
  | "TITLE_GENERATED";

export interface TreeChangeEntry {
  timestamp: string;
  event: TreeChangeEvent;
  change: ChangeDetails;
  snapshot: TreeSnapshot;
}

export interface ChangeDetails {
  conversationId?: string | undefined;
  turnNumber?: number | undefined;
  sequenceNumber?: number | undefined;
  characterization?: string | undefined;
  title?: string | undefined;
  status?: string | undefined;
  tokens?: { input: number; output: number; maxInput: number } | undefined;
  freedTokens?: number | undefined;
  errorMessage?: string | undefined;
  subagentName?: string | undefined;
  count?: number | undefined;
  streaming?: boolean | undefined;
  tokenContribution?: number | undefined;
  previousTitle?: string | undefined;
  previousStatus?: string | undefined;
  previousTokens?:
    | { input: number; output: number; maxInput: number }
    | undefined;
  subagentId?: string | undefined;
  [key: string]: unknown;
}

export interface TreeSnapshot {
  conversationCount: number;
  conversations: ConversationSnapshot[];
}

export interface ConversationSnapshot {
  id: string;
  title: string;
  status: string;
  tokens: { input: number; output: number; maxInput: number };
  turnCount: number;
  activityLog: ActivityLogSnapshot[];
  subagents: SubagentSnapshot[];
}

export interface ActivityLogSnapshot {
  type: "user-message" | "ai-response" | "turn" | "compaction" | "error";
  turnNumber?: number | undefined;
  sequenceNumber?: number | undefined;
  preview?: string | undefined;
  state?: string | undefined;
  characterization?: string | undefined;
  tokenContribution?: number | undefined;
  streaming?: boolean | undefined;
  freedTokens?: number | undefined;
  message?: string | undefined;
  subagentIds?: string[] | undefined;
}

interface LegacyTurnEntry {
  type: "turn";
  turnNumber: number;
  timestamp: number;
  characterization?: string | undefined;
  outputTokens: number;
  subagentIds: string[];
  streaming: boolean;
}

export interface SubagentSnapshot {
  id: string;
  name: string;
  status: string;
  tokens: { input: number; output: number };
  children: SubagentSnapshot[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

class TreeChangeLogger {
  private logPath: string | null = null;
  private enabled = false;
  private previousSnapshot: TreeSnapshot | null = null;

  /**
   * Initialize the logger for a workspace.
   */
  initialize(workspaceRoot: string): void {
    const logsDir = path.join(workspaceRoot, ".logs");

    // Ensure .logs directory exists
    try {
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      this.logPath = path.join(logsDir, "tree-changes.jsonl");
      this.enabled = true;

      // Log initialization
      this.log(
        "TREE_INITIALIZED",
        {},
        { conversationCount: 0, conversations: [] },
      );
    } catch {
      // Silently fail if we can't create the log directory
      this.enabled = false;
    }
  }

  /**
   * Log a tree change with full snapshot.
   */
  log(
    event: TreeChangeEvent,
    change: ChangeDetails,
    snapshot: TreeSnapshot,
  ): void {
    if (!this.enabled || !this.logPath) return;

    const entry: TreeChangeEntry = {
      timestamp: new Date().toISOString(),
      event,
      change,
      snapshot,
    };

    try {
      // eslint-disable-next-line no-restricted-syntax -- Intentional sync write for diagnostic JSONL log
      fs.appendFileSync(this.logPath, safeJsonStringify(entry) + "\n", "utf8");
    } catch {
      // Silently fail on write errors
    }

    this.previousSnapshot = snapshot;
  }

  /**
   * Log changes by diffing current state against previous snapshot.
   * This is the main entry point called when conversations change.
   */
  logChanges(conversations: Conversation[]): void {
    if (!this.enabled) return;

    const snapshot = this.buildSnapshot(conversations);
    const previous = this.previousSnapshot;

    if (!previous) {
      // First snapshot after initialization
      if (conversations.length > 0) {
        this.log(
          "CONVERSATION_ADDED",
          {
            conversationId: conversations[0]?.id,
            count: conversations.length,
          },
          snapshot,
        );
      }
      this.previousSnapshot = snapshot;
      return;
    }

    // Detect changes by comparing snapshots
    const changes = this.detectChanges(previous, snapshot, conversations);

    for (const { event, change } of changes) {
      this.log(event, change, snapshot);
    }

    this.previousSnapshot = snapshot;
  }

  /**
   * Build a snapshot from the current conversation state.
   */
  private buildSnapshot(conversations: Conversation[]): TreeSnapshot {
    return {
      conversationCount: conversations.length,
      conversations: conversations.map((conv) =>
        this.snapshotConversation(conv),
      ),
    };
  }

  private snapshotConversation(conv: Conversation): ConversationSnapshot {
    return {
      id: conv.id,
      title: conv.title,
      status: conv.status,
      tokens: {
        input: conv.tokens.input,
        output: conv.tokens.output,
        maxInput: conv.tokens.maxInput,
      },
      turnCount: conv.turnCount,
      activityLog: conv.activityLog.map((entry) =>
        this.snapshotActivityEntry(entry),
      ),
      subagents: conv.subagents.map((sub) => this.snapshotSubagent(sub)),
    };
  }

  private snapshotActivityEntry(
    entry: ActivityLogEntry | LegacyTurnEntry,
  ): ActivityLogSnapshot {
    switch (entry.type) {
      case "user-message":
        return {
          type: "user-message",
          sequenceNumber: entry.sequenceNumber,
          preview: entry.preview,
        };
      case "ai-response":
        return {
          type: "ai-response",
          sequenceNumber: entry.sequenceNumber,
          state: entry.state,
          characterization: entry.characterization,
          tokenContribution: entry.tokenContribution,
          subagentIds: entry.subagentIds,
        };
      case "turn":
        return {
          type: "turn",
          turnNumber: entry.turnNumber,
          characterization: entry.characterization,
          streaming: entry.streaming,
        };
      case "compaction":
        return {
          type: "compaction",
          turnNumber: entry.turnNumber,
          freedTokens: entry.freedTokens,
        };
      case "error":
        return {
          type: "error",
          turnNumber: entry.turnNumber,
          message: entry.message,
        };
    }
  }

  private snapshotSubagent(sub: Subagent): SubagentSnapshot {
    return {
      id: sub.conversationId,
      name: sub.name,
      status: sub.status,
      tokens: { input: sub.tokens.input, output: sub.tokens.output },
      children: sub.children.map((child) => this.snapshotSubagent(child)),
    };
  }

  /**
   * Detect what changed between two snapshots.
   */
  private detectChanges(
    previous: TreeSnapshot,
    current: TreeSnapshot,
    _conversations: Conversation[],
  ): { event: TreeChangeEvent; change: ChangeDetails }[] {
    const changes: { event: TreeChangeEvent; change: ChangeDetails }[] = [];

    const prevConvMap = new Map(previous.conversations.map((c) => [c.id, c]));
    const currConvMap = new Map(current.conversations.map((c) => [c.id, c]));

    // Check for new conversations
    for (const conv of current.conversations) {
      if (!prevConvMap.has(conv.id)) {
        changes.push({
          event: "CONVERSATION_ADDED",
          change: {
            conversationId: conv.id,
            title: conv.title,
            status: conv.status,
          },
        });
      }
    }

    // Check for removed conversations
    for (const conv of previous.conversations) {
      if (!currConvMap.has(conv.id)) {
        changes.push({
          event: "CONVERSATION_REMOVED",
          change: { conversationId: conv.id },
        });
      }
    }

    // Check for changes within existing conversations
    for (const curr of current.conversations) {
      const prev = prevConvMap.get(curr.id);
      if (!prev) continue;

      // Title changed
      if (curr.title !== prev.title) {
        changes.push({
          event: "TITLE_GENERATED",
          change: {
            conversationId: curr.id,
            title: curr.title,
            previousTitle: prev.title,
          },
        });
      }

      // Status changed
      if (curr.status !== prev.status) {
        changes.push({
          event: "STATUS_CHANGED",
          change: {
            conversationId: curr.id,
            status: curr.status,
            previousStatus: prev.status,
          },
        });
      }

      // Tokens changed significantly
      if (
        curr.tokens.input !== prev.tokens.input ||
        curr.tokens.output !== prev.tokens.output
      ) {
        changes.push({
          event: "TOKENS_UPDATED",
          change: {
            conversationId: curr.id,
            tokens: curr.tokens,
            previousTokens: prev.tokens,
          },
        });
      }

      // Activity log changes
      const prevLogLength = prev.activityLog.length;
      const currLogLength = curr.activityLog.length;

      if (currLogLength > prevLogLength) {
        // New entries added
        for (let i = prevLogLength; i < currLogLength; i++) {
          const entry = curr.activityLog[i];
          if (!entry) continue;

          switch (entry.type) {
            case "user-message":
              changes.push({
                event: "USER_MESSAGE_ADDED",
                change: {
                  conversationId: curr.id,
                  sequenceNumber: entry.sequenceNumber,
                },
              });
              break;
            case "ai-response":
              changes.push({
                event: "AI_RESPONSE_ADDED",
                change: {
                  conversationId: curr.id,
                  sequenceNumber: entry.sequenceNumber,
                  streaming: entry.state === "streaming",
                },
              });
              break;
            case "turn":
              changes.push({
                event: "TURN_ADDED",
                change: {
                  conversationId: curr.id,
                  turnNumber: entry.turnNumber,
                  streaming: entry.streaming,
                },
              });
              break;
            case "compaction":
              changes.push({
                event: "COMPACTION_ADDED",
                change: {
                  conversationId: curr.id,
                  turnNumber: entry.turnNumber,
                  freedTokens: entry.freedTokens,
                },
              });
              break;
            case "error":
              changes.push({
                event: "ERROR_ADDED",
                change: {
                  conversationId: curr.id,
                  errorMessage: entry.message,
                },
              });
              break;
          }
        }
      }

      // Check for turn characterization updates
      for (let i = 0; i < Math.min(prevLogLength, currLogLength); i++) {
        const prevEntry = prev.activityLog[i];
        const currEntry = curr.activityLog[i];
        if (
          prevEntry?.type === "ai-response" &&
          currEntry?.type === "ai-response" &&
          currEntry.characterization &&
          currEntry.characterization !== prevEntry.characterization
        ) {
          changes.push({
            event: "AI_RESPONSE_CHARACTERIZED",
            change: {
              conversationId: curr.id,
              sequenceNumber: currEntry.sequenceNumber,
              characterization: currEntry.characterization,
            },
          });
        }

        if (
          prevEntry?.type === "turn" &&
          currEntry?.type === "turn" &&
          currEntry.characterization &&
          currEntry.characterization !== prevEntry.characterization
        ) {
          changes.push({
            event: "TURN_CHARACTERIZED",
            change: {
              conversationId: curr.id,
              turnNumber: currEntry.turnNumber,
              characterization: currEntry.characterization,
            },
          });
        }

        // Check for turn streaming → complete transition
        if (
          prevEntry?.type === "ai-response" &&
          currEntry?.type === "ai-response" &&
          prevEntry.state === "streaming" &&
          currEntry.state !== "streaming"
        ) {
          changes.push({
            event: "AI_RESPONSE_UPDATED",
            change: {
              conversationId: curr.id,
              sequenceNumber: currEntry.sequenceNumber,
              tokenContribution: currEntry.tokenContribution,
              streaming: false,
            },
          });
        }

        if (
          prevEntry?.type === "turn" &&
          currEntry?.type === "turn" &&
          prevEntry.streaming &&
          !currEntry.streaming
        ) {
          changes.push({
            event: "TURN_UPDATED",
            change: {
              conversationId: curr.id,
              turnNumber: currEntry.turnNumber,
              streaming: false,
            },
          });
        }
      }

      // Subagent changes
      if (curr.subagents.length > prev.subagents.length) {
        const prevSubIds = new Set(prev.subagents.map((s) => s.id));
        for (const sub of curr.subagents) {
          if (!prevSubIds.has(sub.id)) {
            changes.push({
              event: "SUBAGENT_ADDED",
              change: {
                conversationId: curr.id,
                subagentName: sub.name,
                subagentId: sub.id,
              },
            });
          }
        }
      }
    }

    return changes;
  }

  /**
   * Check if logging is enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }
}

// Singleton instance
let instance: TreeChangeLogger | null = null;

export function getTreeChangeLogger(): TreeChangeLogger {
  instance ??= new TreeChangeLogger();
  return instance;
}

/**
 * Initialize tree change logging for a workspace.
 * Call this from extension activation.
 */
export function initializeTreeChangeLog(workspaceRoot: string): void {
  getTreeChangeLogger().initialize(workspaceRoot);
}
