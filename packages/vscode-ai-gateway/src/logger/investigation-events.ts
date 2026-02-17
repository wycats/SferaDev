import type {
  IndexEntry,
  MessageSummary,
  FullRequestCapture,
  SSEEventEntry,
} from "./investigation.js";
import type { TokenUsage } from "../agent/types.js";
import type { AIResponseState } from "../conversation/types.js";

// ── Tree Change Op Types ─────────────────────────────────────────────
// Typed discriminated union for tree change events (RFC 00075).
// These replace the old unstructured TreeChangeEvent + ChangeDetails.

// -- Snapshot types (enriched for tree reconstruction) --

export interface EventConversationSnapshot {
  id: string;
  title: string;
  modelId: string;
  status: "active" | "idle" | "archived";
  startTime: number;
  lastActiveTime: number;
  tokens: { input: number; output: number; maxInput: number };
  turnCount: number;
  totalOutputTokens: number;
  activityLog: EventActivityLogSnapshot[];
  subagents: EventSubagentSnapshot[];
  workspaceFolder?: string;
  forkedFrom?: { conversationId: string; atSequence: number };
}

export interface EventUserMessageSnapshot {
  type: "user-message";
  sequenceNumber: number;
  timestamp: number;
  preview?: string;
  tokenContribution?: number;
  isToolContinuation?: boolean;
}

export interface EventAIResponseSnapshot {
  type: "ai-response";
  sequenceNumber: number;
  timestamp: number;
  state: AIResponseState;
  characterization?: string;
  tokenContribution: number;
  subagentIds: string[];
  toolsUsed?: string[];
}

export interface EventCompactionSnapshot {
  type: "compaction";
  timestamp: number;
  turnNumber: number;
  freedTokens: number;
  compactionType: "summarization" | "context_management";
  details?: string;
}

export interface EventErrorSnapshot {
  type: "error";
  timestamp: number;
  turnNumber?: number;
  message: string;
}

export type EventActivityLogSnapshot =
  | EventUserMessageSnapshot
  | EventAIResponseSnapshot
  | EventCompactionSnapshot
  | EventErrorSnapshot;

export interface EventSubagentSnapshot {
  id: string;
  name: string;
  status: "streaming" | "complete" | "error";
  tokens: { input: number; output: number };
  turnCount: number;
  children: EventSubagentSnapshot[];
}

// -- TreeChangeOp discriminated union --

export type TreeChangeOp =
  // Conversation lifecycle
  | {
      type: "conversation-added";
      conversation: EventConversationSnapshot;
    }
  | {
      type: "conversation-removed";
      conversationId: string;
    }
  | {
      type: "conversation-forked";
      conversationId: string;
      forkedFrom: string;
      atSequence: number;
      previousMessageCount: number;
      newMessageCount: number;
    }
  // Conversation field updates
  | {
      type: "status-changed";
      conversationId: string;
      status: "active" | "idle" | "archived";
    }
  | {
      type: "title-changed";
      conversationId: string;
      title: string;
    }
  | {
      type: "tokens-updated";
      conversationId: string;
      tokens: { input: number; output: number; maxInput: number };
    }
  // Activity log entries (creates)
  | {
      type: "user-message-added";
      conversationId: string;
      entry: EventUserMessageSnapshot;
    }
  | {
      type: "ai-response-added";
      conversationId: string;
      entry: EventAIResponseSnapshot;
    }
  | {
      type: "compaction-added";
      conversationId: string;
      entry: EventCompactionSnapshot;
    }
  | {
      type: "error-added";
      conversationId: string;
      entry: EventErrorSnapshot;
    }
  // Activity log entries (updates)
  | {
      type: "user-message-updated";
      conversationId: string;
      sequenceNumber: number;
      fields: Partial<
        Omit<EventUserMessageSnapshot, "type" | "sequenceNumber" | "timestamp">
      >;
    }
  | {
      type: "ai-response-updated";
      conversationId: string;
      sequenceNumber: number;
      fields: Partial<
        Omit<EventAIResponseSnapshot, "type" | "sequenceNumber" | "timestamp">
      >;
    }
  | {
      type: "ai-response-characterized";
      conversationId: string;
      sequenceNumber: number;
      characterization: string;
    }
  // Subagents
  | {
      type: "subagent-added";
      conversationId: string;
      subagent: EventSubagentSnapshot;
    };

export type InvestigationEventKind =
  // Request lifecycle (emitted by InvestigationRequestHandle)
  | "request.index"
  | "request.message-summary"
  | "request.full"
  | "request.sse"
  // Tree changes (emitted by TreeChangeLogger bridge)
  | "tree.change"
  // Tree snapshots (emitted at lifecycle boundaries)
  | "tree.snapshot"
  // Agent registry (emitted by RegistryEventBridge)
  | "agent.started"
  | "agent.completed"
  | "agent.errored"
  | "agent.updated"
  | "agent.removed"
  // Lifecycle (emitted by extension activation/deactivation)
  | "session.start"
  | "session.end";

export interface InvestigationEventBase {
  kind: InvestigationEventKind;
  /** Monotonic, lexicographically sortable event identifier (ULID). */
  eventId: string;
  ts: string;
  sessionId: string;
  conversationId: string;
  chatId: string;
  parentChatId?: string | null;
  agentTypeHash?: string | null;
  /** The chat ID of the request that caused this event (for tree→request causality). */
  causedByChatId?: string | null;
}

export interface InvestigationIndexEvent extends InvestigationEventBase {
  kind: "request.index";
  entry: IndexEntry;
}

export interface InvestigationMessageSummaryEvent extends InvestigationEventBase {
  kind: "request.message-summary";
  summary: MessageSummary;
}

export interface InvestigationFullRequestEvent extends InvestigationEventBase {
  kind: "request.full";
  capture: FullRequestCapture;
}

export interface InvestigationSseEvent extends InvestigationEventBase {
  kind: "request.sse";
  entry: SSEEventEntry;
}

export interface InvestigationTreeChangeEvent extends InvestigationEventBase {
  kind: "tree.change";
  op: TreeChangeOp;
}

// ── Agent Registry Events ────────────────────────────────────────────

export interface InvestigationAgentStartedEvent extends InvestigationEventBase {
  kind: "agent.started";
  agentId: string;
  canonicalAgentId: string;
  isMain: boolean;
  isResume: boolean;
  parentConversationHash?: string | null;
}

export interface InvestigationAgentCompletedEvent extends InvestigationEventBase {
  kind: "agent.completed";
  agentId: string;
  canonicalAgentId: string;
  usage: TokenUsage;
  turnCount: number;
  summarizationDetected: boolean;
}

export interface InvestigationAgentErroredEvent extends InvestigationEventBase {
  kind: "agent.errored";
  agentId: string;
  canonicalAgentId: string;
}

export interface InvestigationAgentUpdatedEvent extends InvestigationEventBase {
  kind: "agent.updated";
  agentId: string;
  canonicalAgentId: string;
  updateType:
    | "turn-count-sync"
    | "title-generated"
    | "child-linked"
    | "main-demoted";
}

export interface InvestigationAgentRemovedEvent extends InvestigationEventBase {
  kind: "agent.removed";
  agentId: string;
  reason: "aged" | "cleared";
}

// ── Tree Snapshot Events ─────────────────────────────────────────────

export type TreeSnapshotTrigger =
  | "session-start"
  | "session-end"
  | "idle"
  | "removed";

export interface InvestigationTreeSnapshotEvent extends InvestigationEventBase {
  kind: "tree.snapshot";
  trigger: TreeSnapshotTrigger;
  conversations: EventConversationSnapshot[];
}

// ── Lifecycle Events ─────────────────────────────────────────────────

export interface InvestigationSessionStartEvent extends InvestigationEventBase {
  kind: "session.start";
  extensionVersion: string;
}

export interface InvestigationSessionEndEvent extends InvestigationEventBase {
  kind: "session.end";
}

// ── Union ────────────────────────────────────────────────────────────

export type InvestigationEvent =
  | InvestigationIndexEvent
  | InvestigationMessageSummaryEvent
  | InvestigationFullRequestEvent
  | InvestigationSseEvent
  | InvestigationTreeChangeEvent
  | InvestigationTreeSnapshotEvent
  | InvestigationAgentStartedEvent
  | InvestigationAgentCompletedEvent
  | InvestigationAgentErroredEvent
  | InvestigationAgentUpdatedEvent
  | InvestigationAgentRemovedEvent
  | InvestigationSessionStartEvent
  | InvestigationSessionEndEvent;

export interface InvestigationSubscriber {
  onEvent(event: InvestigationEvent): void;
}
