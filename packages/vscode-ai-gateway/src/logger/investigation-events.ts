import type {
  IndexEntry,
  MessageSummary,
  FullRequestCapture,
  SSEEventEntry,
} from "./investigation.js";
import type {
  TreeChangeEvent,
  ChangeDetails,
  TreeSnapshot,
} from "../diagnostics/tree-change-log.js";
import type { TokenUsage } from "../agent/types.js";

export type InvestigationEventKind =
  // Request lifecycle (emitted by InvestigationRequestHandle)
  | "request.index"
  | "request.message-summary"
  | "request.full"
  | "request.sse"
  // Tree changes (emitted by TreeChangeLogger bridge)
  | "tree.change"
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
  event: TreeChangeEvent;
  change?: ChangeDetails;
  snapshot?: TreeSnapshot;
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
