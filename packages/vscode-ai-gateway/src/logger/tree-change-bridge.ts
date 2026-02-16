/**
 * Tree Change Bridge
 *
 * Bridges TreeChangeLogger events into the unified InvestigationEvent stream.
 *
 * The TreeChangeLogger writes to its own JSONL file for backward compatibility.
 * This bridge additionally emits tree.change InvestigationEvents so they appear
 * in the unified event stream alongside request and registry events.
 *
 * Each tree.change event carries causedByChatId, linking it to the request
 * that triggered the tree rebuild.
 */

import type { InvestigationEvent } from "./investigation-events.js";
import type {
  TreeChangeEvent,
  ChangeDetails,
  TreeSnapshot,
  TreeChangeEventEmitter,
} from "../diagnostics/tree-change-log.js";
import { ulid } from "../utils/ulid.js";

/**
 * Create a TreeChangeEventEmitter that translates tree changes into
 * InvestigationTreeChangeEvents and emits them through the provided function.
 */
export function createTreeChangeBridge(
  sessionId: string,
  emit: (event: InvestigationEvent) => void,
): TreeChangeEventEmitter {
  return (
    event: TreeChangeEvent,
    change: ChangeDetails,
    snapshot: TreeSnapshot,
    causedByChatId?: string,
  ) => {
    emit({
      kind: "tree.change",
      eventId: ulid(),
      ts: new Date().toISOString(),
      sessionId,
      // Tree changes are conversation-level; use the first conversation ID if available
      conversationId: snapshot.conversations[0]?.id ?? "unknown",
      chatId: causedByChatId ?? "unknown",
      causedByChatId: causedByChatId ?? null,
      event,
      change,
      // Omit full snapshot from events to keep the stream lean.
      // The snapshot is still written to tree-changes.jsonl for full debugging.
    });
  };
}
