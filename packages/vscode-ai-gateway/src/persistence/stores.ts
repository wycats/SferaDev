/**
 * Concrete store configurations for the persistence layer.
 */

import type { AIResponseState } from "@vercel/conversation";
import { logger } from "../logger.js";
import type { StoreConfig } from "./types.js";

/**
 * Aggregate session statistics for display on boot.
 */
export interface SessionStats {
  /** When stats were last updated */
  timestamp: number;
  /** Total agents tracked in session */
  agentCount: number;
  /** Main agent turn count */
  mainAgentTurns: number;
  /** Max context size reached (not sum) */
  maxObservedInputTokens: number;
  /** Accumulated output tokens */
  totalOutputTokens: number;
  /** Primary model used */
  modelId: string | null;
}

export const SESSION_STATS_STORE: StoreConfig<SessionStats> = {
  key: "vercel.ai.sessionStats",
  version: 1,
  scope: "global",
  defaultValue: {
    timestamp: 0,
    agentCount: 0,
    mainAgentTurns: 0,
    maxObservedInputTokens: 0,
    totalOutputTokens: 0,
    modelId: null,
  },
  // Legacy key from pre-rebrand extension (SferaDev -> Vercel)
  legacyKeys: ["vercelAiGateway.sessionStats"],
};

/**
 * Per-conversation agent state for delta token estimation.
 * Persisted to enable accurate token display across VS Code reloads.
 */
export interface PersistedAgentState {
  /** Actual input tokens from last completed turn (from API response) */
  lastActualInputTokens: number;
  /** Number of messages in last completed request */
  lastMessageCount: number;
  /** Number of completed turns in this conversation */
  turnCount: number;
  /** Model used (for diagnostics) */
  modelId?: string;
  /** Whether VS Code summarization was detected */
  summarizationDetected?: boolean;
  /** Total tokens freed by summarization */
  summarizationReduction?: number;
  /** Timestamp for LRU eviction (named fetchedAt for store.ts compatibility) */
  fetchedAt: number;
}

/**
 * Wrapper for per-conversation agent state store.
 * Keyed by conversationId (stable UUID from stateful marker sessionId).
 */
export interface PersistedAgentStateMap {
  entries: Record<string, PersistedAgentState>;
}

export const AGENT_STATE_STORE: StoreConfig<PersistedAgentStateMap> = {
  key: "vercel.ai.agentState",
  version: 1,
  scope: "global",
  defaultValue: { entries: {} },
  maxEntries: 100,
  ttlMs: 7 * 24 * 60 * 60 * 1000, // 7 days
};

// ── Conversation Tree Persistence ─────────────────────────────────────

/**
 * Persisted conversation for tree restoration across reloads.
 * Subset of Conversation type with only the fields needed for display.
 */
export interface PersistedConversation {
  id: string;
  title: string;
  firstMessagePreview?: string;
  modelId: string;
  status: "active" | "idle" | "archived";
  startTime: number;
  lastActiveTime: number;
  tokens: { input: number; output: number; maxInput: number };
  turnCount: number;
  totalOutputTokens: number;
  /** Serialized activity log entries */
  activityLog: PersistedActivityLogEntry[];
  /** Serialized subagent hierarchy */
  subagents: PersistedSubagent[];
  /** Workspace folder path, if available */
  workspaceFolder?: string;
}

/**
 * Persisted activity log entry (union type serialized).
 */
export type PersistedActivityLogEntry =
  | {
      type: "user-message";
      sequenceNumber: number;
      timestamp: number;
      preview?: string;
      tokenContribution?: number;
      isToolContinuation?: boolean;
    }
  | {
      type: "ai-response";
      sequenceNumber: number;
      timestamp: number;
      state: AIResponseState;
      characterization?: string;
      tokenContribution: number;
      subagentIds: string[];
    }
  | {
      type: "turn";
      turnNumber: number;
      timestamp: number;
      characterization?: string;
      outputTokens: number;
      subagentIds: string[];
      streaming: boolean;
    }
  | {
      type: "compaction";
      timestamp: number;
      turnNumber: number;
      freedTokens: number;
      compactionType: "summarization" | "context_management";
      details?: string;
    }
  | {
      type: "error";
      timestamp: number;
      turnNumber?: number;
      message: string;
    };

/**
 * Persisted subagent for tree restoration.
 */
export interface PersistedSubagent {
  conversationId: string;
  name: string;
  tokens: { input: number; output: number };
  turnCount: number;
  status: "streaming" | "complete" | "error";
  children: PersistedSubagent[];
}

/**
 * Wrapper for conversation tree store.
 */
export interface PersistedConversationMap {
  conversations: Record<string, PersistedConversation>;
}

type PersistedActivityLogEntryV1 =
  | {
      type: "turn";
      turnNumber: number;
      timestamp: number;
      characterization?: string;
      outputTokens: number;
      subagentIds: string[];
      streaming: boolean;
    }
  | {
      type: "compaction";
      timestamp: number;
      turnNumber: number;
      freedTokens: number;
      compactionType: "summarization" | "context_management";
      details?: string;
    }
  | {
      type: "error";
      timestamp: number;
      turnNumber?: number;
      message: string;
    };

type PersistedConversationV1 = Omit<PersistedConversation, "activityLog"> & {
  activityLog: PersistedActivityLogEntryV1[];
};

interface PersistedConversationMapV1 {
  conversations: Record<string, PersistedConversationV1>;
}

const DEFAULT_CONVERSATION_MAP: PersistedConversationMap = {
  conversations: {},
};

const migrateConversationTree = (
  oldValue: unknown,
  oldVersion: number,
): PersistedConversationMap => {
  // Wipe corrupted data from execute subagent - start fresh
  if (oldVersion < 8) {
    return DEFAULT_CONVERSATION_MAP;
  }

  if (!oldValue || typeof oldValue !== "object") {
    logger.info("[MIGRATION] No old value, returning default");
    return DEFAULT_CONVERSATION_MAP;
  }

  const record = oldValue as Partial<PersistedConversationMapV1>;
  if (!record.conversations || typeof record.conversations !== "object") {
    logger.info("[MIGRATION] No conversations, returning default");
    return DEFAULT_CONVERSATION_MAP;
  }

  logger.info(
    `[MIGRATION] Found ${Object.keys(record.conversations).length} conversations`,
  );
  const migrated: PersistedConversationMap = { conversations: {} };

  for (const [id, conversation] of Object.entries(record.conversations)) {
    const rawActivityLog: unknown = conversation.activityLog;
    const activityLog = Array.isArray(rawActivityLog) ? rawActivityLog : [];
    const migratedLog: PersistedActivityLogEntry[] = [];

    for (const entry of activityLog) {
      if (!entry || typeof entry !== "object" || !("type" in entry)) {
        continue;
      }
      // Persisted data may be in old (V1: turn/compaction/error) or new
      // (user-message/ai-response/compaction/error) format. Use a broad
      // type so the switch can handle both.
      const typedEntry = entry as
        | PersistedActivityLogEntryV1
        | PersistedActivityLogEntry;

      switch (typedEntry.type) {
        case "user-message":
        case "ai-response": {
          // Data already in new format — migrate field names if needed
          const record: Record<string, unknown> = { ...typedEntry };

          logger.info(
            `[MIGRATION] Entry keys: ${Object.keys(record).join(", ")}, sequenceNumber in record: ${"sequenceNumber" in record}, value: ${String(record["sequenceNumber"])}`,
          );

          // Handle exchangeNumber → sequenceNumber rename
          if ("exchangeNumber" in record) {
            record["sequenceNumber"] = record["exchangeNumber"];
            delete record["exchangeNumber"];
          }

          // Handle outputTokens → tokenContribution rename for ai-response
          if (typedEntry.type === "ai-response" && "outputTokens" in record) {
            record["tokenContribution"] = record["outputTokens"];
            delete record["outputTokens"];
          }

          // Skip entries missing sequenceNumber (corrupted data)
          const hasSeqNum = "sequenceNumber" in record;
          const seqNumValue = record["sequenceNumber"];
          logger.info(
            `[MIGRATION] Check: hasSeqNum=${hasSeqNum}, value=${String(seqNumValue)}, isNull=${seqNumValue == null}`,
          );

          if (!hasSeqNum || seqNumValue == null) {
            // Can't recover - skip this entry
            logger.info(
              `[MIGRATION] Skipping ${typedEntry.type} entry missing sequenceNumber`,
            );
            break;
          }

          // Fix streaming state on restore - should be interrupted
          if (
            typedEntry.type === "ai-response" &&
            record["state"] === "streaming"
          ) {
            record["state"] = "interrupted";
          }

          // Ensure ai-response has required fields
          if (typedEntry.type === "ai-response") {
            if (!("tokenContribution" in record)) {
              record["tokenContribution"] = 0;
            }
            if (!("subagentIds" in record)) {
              record["subagentIds"] = [];
            }
            if (!("state" in record)) {
              record["state"] = "uncharacterized";
            }
          }

          migratedLog.push(record as PersistedActivityLogEntry);
          break;
        }
        case "compaction":
        case "error":
          migratedLog.push(typedEntry as PersistedActivityLogEntry);
          break;
        case "turn": {
          const sequenceNumber = typedEntry.turnNumber;
          const preview =
            sequenceNumber === 1 ? conversation.firstMessagePreview : undefined;
          migratedLog.push({
            type: "user-message",
            sequenceNumber,
            timestamp: typedEntry.timestamp,
            ...(preview ? { preview } : {}),
          });

          // Streaming turns become interrupted on restore
          const state: AIResponseState = typedEntry.streaming
            ? "interrupted"
            : typedEntry.characterization
              ? "characterized"
              : "uncharacterized";

          migratedLog.push({
            type: "ai-response",
            sequenceNumber,
            timestamp: typedEntry.timestamp,
            state,
            ...(typedEntry.characterization
              ? { characterization: typedEntry.characterization }
              : {}),
            tokenContribution: typedEntry.outputTokens,
            subagentIds: typedEntry.subagentIds,
          });
          break;
        }
      }
    }

    logger.info(
      `[MIGRATION] Conversation ${id}: ${activityLog.length} entries -> ${migratedLog.length} entries`,
    );
    migrated.conversations[id] = {
      ...conversation,
      activityLog: migratedLog,
    };
  }

  logger.info(
    `[MIGRATION] Complete. Total conversations: ${Object.keys(migrated.conversations).length}`,
  );
  return migrated;
};

export const CONVERSATION_TREE_STORE: StoreConfig<PersistedConversationMap> = {
  key: "vercel.ai.conversationTree",
  version: 9, // v9: moved from globalState to workspaceState
  scope: "workspace",
  defaultValue: { conversations: {} },
  maxEntries: 50,
  ttlMs: 24 * 60 * 60 * 1000, // 24 hours - conversations older than this are pruned
  migrate: migrateConversationTree,
};
