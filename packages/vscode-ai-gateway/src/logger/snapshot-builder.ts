/**
 * Snapshot Builder — converts Conversation domain types to event snapshot types.
 *
 * Used by tree.snapshot emission and tree.change ops to produce
 * EventConversationSnapshot from the live Conversation model.
 */

import type {
  Conversation,
  ActivityLogEntry,
  Subagent,
} from "@vercel/conversation";
import type {
  EventConversationSnapshot,
  EventActivityLogSnapshot,
  EventSubagentSnapshot,
} from "./investigation-events.js";

/**
 * Convert a Conversation to an EventConversationSnapshot for event emission.
 */
export function toConversationSnapshot(
  conversation: Conversation,
): EventConversationSnapshot {
  return {
    id: conversation.id,
    title: conversation.title,
    modelId: conversation.modelId,
    status: conversation.status,
    startTime: conversation.startTime,
    lastActiveTime: conversation.lastActiveTime,
    tokens: { ...conversation.tokens },
    turnCount: conversation.turnCount,
    totalOutputTokens: conversation.totalOutputTokens,
    activityLog: conversation.activityLog.map(toActivityLogSnapshot),
    subagents: conversation.subagents.map(toSubagentSnapshot),
    ...(conversation.workspaceFolder
      ? { workspaceFolder: conversation.workspaceFolder }
      : {}),
  };
}

/**
 * Convert an array of Conversations to EventConversationSnapshot[].
 */
export function toConversationSnapshots(
  conversations: Conversation[],
): EventConversationSnapshot[] {
  return conversations.map(toConversationSnapshot);
}

function toActivityLogSnapshot(
  entry: ActivityLogEntry,
): EventActivityLogSnapshot {
  switch (entry.type) {
    case "user-message":
      return {
        type: "user-message",
        sequenceNumber: entry.sequenceNumber,
        timestamp: entry.timestamp,
        ...(entry.preview !== undefined ? { preview: entry.preview } : {}),
        ...(entry.tokenContribution !== undefined
          ? { tokenContribution: entry.tokenContribution }
          : {}),
        ...(entry.isToolContinuation !== undefined
          ? { isToolContinuation: entry.isToolContinuation }
          : {}),
      };
    case "ai-response":
      return {
        type: "ai-response",
        sequenceNumber: entry.sequenceNumber,
        timestamp: entry.timestamp,
        state: entry.state,
        ...(entry.characterization !== undefined
          ? { characterization: entry.characterization }
          : {}),
        tokenContribution: entry.tokenContribution,
        subagentIds: [...entry.subagentIds],
        ...(entry.toolsUsed !== undefined
          ? { toolsUsed: [...entry.toolsUsed] }
          : {}),
      };
    case "compaction":
      return {
        type: "compaction",
        timestamp: entry.timestamp,
        turnNumber: entry.turnNumber,
        freedTokens: entry.freedTokens,
        compactionType: entry.compactionType,
        ...(entry.details !== undefined ? { details: entry.details } : {}),
      };
    case "error":
      return {
        type: "error",
        timestamp: entry.timestamp,
        ...(entry.turnNumber !== undefined
          ? { turnNumber: entry.turnNumber }
          : {}),
        message: entry.message,
      };
  }
}

function toSubagentSnapshot(subagent: Subagent): EventSubagentSnapshot {
  return {
    id: subagent.conversationId,
    name: subagent.name,
    status: subagent.status,
    tokens: { ...subagent.tokens },
    turnCount: subagent.turnCount,
    children: subagent.children.map(toSubagentSnapshot),
  };
}
