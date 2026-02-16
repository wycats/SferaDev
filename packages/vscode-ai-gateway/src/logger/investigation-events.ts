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

export type InvestigationEventKind =
  | "request.index"
  | "request.message-summary"
  | "request.full"
  | "request.sse"
  | "tree.change";

export interface InvestigationEventBase {
  kind: InvestigationEventKind;
  ts: string;
  sessionId: string;
  conversationId: string;
  chatId: string;
  parentChatId?: string | null;
  agentTypeHash?: string | null;
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

export type InvestigationEvent =
  | InvestigationIndexEvent
  | InvestigationMessageSummaryEvent
  | InvestigationFullRequestEvent
  | InvestigationSseEvent
  | InvestigationTreeChangeEvent;

export interface InvestigationSubscriber {
  onEvent(event: InvestigationEvent): void;
}
