/**
 * Tree Change Log
 *
 * Emits typed tree.change ops to the unified investigation event stream.
 */

import type { Conversation } from "../conversation/types.js";
import type {
  InvestigationEvent,
  TreeChangeOp,
  EventConversationSnapshot,
  EventAIResponseSnapshot,
  EventUserMessageSnapshot,
  EventSubagentSnapshot,
} from "../logger/investigation-events.js";
import {
  toConversationSnapshot,
  toConversationSnapshots,
} from "../logger/snapshot-builder.js";
import { ulid } from "../utils/ulid.js";

class TreeChangeLogger {
  private previousSnapshots: EventConversationSnapshot[] | null = null;
  private sessionId: string | null = null;
  private emit: ((event: InvestigationEvent) => void) | null = null;

  setEventEmitter(
    sessionId: string,
    emit: (event: InvestigationEvent) => void,
  ): void {
    this.sessionId = sessionId;
    this.emit = emit;
    this.previousSnapshots = null;
  }

  logChanges(conversations: Conversation[], causedByChatId?: string): void {
    if (!this.emit || !this.sessionId) return;

    const currentSnapshots = toConversationSnapshots(conversations);
    const previous = this.previousSnapshots;

    if (!previous) {
      for (const conversation of conversations) {
        const snapshot = toConversationSnapshot(conversation);
        this.emitOp(
          { type: "conversation-added", conversation: snapshot },
          snapshot.id,
          causedByChatId,
        );
      }
      this.previousSnapshots = currentSnapshots;
      return;
    }

    const ops = this.detectChanges(previous, currentSnapshots);
    for (const op of ops) {
      const conversationId = this.getConversationIdFromOp(op);
      this.emitOp(op, conversationId, causedByChatId);
    }

    this.previousSnapshots = currentSnapshots;
  }

  emitSingleOp(
    op: TreeChangeOp,
    conversationId: string,
    causedByChatId?: string,
  ): void {
    if (!this.emit || !this.sessionId) return;
    this.emitOp(op, conversationId, causedByChatId);
  }

  private emitOp(
    op: TreeChangeOp,
    conversationId: string,
    causedByChatId?: string,
  ): void {
    this.emit!({
      kind: "tree.change",
      eventId: ulid(),
      ts: new Date().toISOString(),
      sessionId: this.sessionId!,
      conversationId,
      chatId: causedByChatId ?? "unknown",
      causedByChatId: causedByChatId ?? null,
      op,
    });
  }

  private getConversationIdFromOp(op: TreeChangeOp): string {
    if (op.type === "conversation-added") return op.conversation.id;
    return op.conversationId;
  }

  private detectChanges(
    previous: EventConversationSnapshot[],
    current: EventConversationSnapshot[],
  ): TreeChangeOp[] {
    const ops: TreeChangeOp[] = [];

    const prevMap = new Map(previous.map((conv) => [conv.id, conv]));
    const currMap = new Map(current.map((conv) => [conv.id, conv]));

    for (const conv of current) {
      if (!prevMap.has(conv.id)) {
        ops.push({ type: "conversation-added", conversation: conv });
      }
    }

    for (const conv of previous) {
      if (!currMap.has(conv.id)) {
        ops.push({ type: "conversation-removed", conversationId: conv.id });
      }
    }

    for (const curr of current) {
      const prev = prevMap.get(curr.id);
      if (!prev) continue;

      if (curr.title !== prev.title) {
        ops.push({
          type: "title-changed",
          conversationId: curr.id,
          title: curr.title,
        });
      }

      if (curr.status !== prev.status) {
        ops.push({
          type: "status-changed",
          conversationId: curr.id,
          status: curr.status,
        });
      }

      if (
        curr.tokens.input !== prev.tokens.input ||
        curr.tokens.output !== prev.tokens.output ||
        curr.tokens.maxInput !== prev.tokens.maxInput
      ) {
        ops.push({
          type: "tokens-updated",
          conversationId: curr.id,
          tokens: curr.tokens,
        });
      }

      if (curr.activityLog.length > prev.activityLog.length) {
        for (
          let i = prev.activityLog.length;
          i < curr.activityLog.length;
          i++
        ) {
          const entry = curr.activityLog[i];
          if (!entry) continue;

          switch (entry.type) {
            case "user-message":
              ops.push({
                type: "user-message-added",
                conversationId: curr.id,
                entry,
              });
              break;
            case "ai-response":
              ops.push({
                type: "ai-response-added",
                conversationId: curr.id,
                entry,
              });
              break;
            case "compaction":
              ops.push({
                type: "compaction-added",
                conversationId: curr.id,
                entry,
              });
              break;
            case "error":
              ops.push({
                type: "error-added",
                conversationId: curr.id,
                entry,
              });
              break;
          }
        }
      }

      const maxEntries = Math.min(
        prev.activityLog.length,
        curr.activityLog.length,
      );
      for (let i = 0; i < maxEntries; i++) {
        const prevEntry = prev.activityLog[i];
        const currEntry = curr.activityLog[i];

        // Detect user message updates (preview added, tool continuation marked)
        if (
          prevEntry?.type === "user-message" &&
          currEntry?.type === "user-message"
        ) {
          type UserMsgFields = Partial<
            Omit<EventUserMessageSnapshot, "type" | "sequenceNumber" | "timestamp">
          >;
          const fields: UserMsgFields = {};
          let hasChanges = false;
          if (!prevEntry.preview && currEntry.preview) {
            fields.preview = currEntry.preview;
            hasChanges = true;
          }
          if (!prevEntry.isToolContinuation && currEntry.isToolContinuation) {
            fields.isToolContinuation = currEntry.isToolContinuation;
            hasChanges = true;
          }
          if (
            prevEntry.tokenContribution !== currEntry.tokenContribution &&
            currEntry.tokenContribution !== undefined
          ) {
            fields.tokenContribution = currEntry.tokenContribution;
            hasChanges = true;
          }
          if (hasChanges) {
            ops.push({
              type: "user-message-updated",
              conversationId: curr.id,
              sequenceNumber: currEntry.sequenceNumber,
              fields,
            });
          }
        }

        if (
          isAIResponseEntry(prevEntry) &&
          isAIResponseEntry(currEntry) &&
          currEntry.characterization &&
          currEntry.characterization !== prevEntry.characterization
        ) {
          ops.push({
            type: "ai-response-characterized",
            conversationId: curr.id,
            sequenceNumber: currEntry.sequenceNumber,
            characterization: currEntry.characterization,
          });
        }

        if (
          isAIResponseEntry(prevEntry) &&
          isAIResponseEntry(currEntry) &&
          prevEntry.state === "streaming" &&
          currEntry.state !== "streaming"
        ) {
          ops.push({
            type: "ai-response-updated",
            conversationId: curr.id,
            sequenceNumber: currEntry.sequenceNumber,
            fields: {
              state: currEntry.state,
              tokenContribution: currEntry.tokenContribution,
            },
          });
        }

        // Detect AI response toolsUsed being added (set after turn completion)
        if (
          isAIResponseEntry(prevEntry) &&
          isAIResponseEntry(currEntry) &&
          (!prevEntry.toolsUsed || prevEntry.toolsUsed.length === 0) &&
          currEntry.toolsUsed &&
          currEntry.toolsUsed.length > 0
        ) {
          ops.push({
            type: "ai-response-updated",
            conversationId: curr.id,
            sequenceNumber: currEntry.sequenceNumber,
            fields: {
              toolsUsed: currEntry.toolsUsed,
            },
          });
        }
      }

      if (curr.subagents.length > prev.subagents.length) {
        const prevSubIds = new Set(
          prev.subagents.map((sub: EventSubagentSnapshot) => sub.id),
        );
        for (const subagent of curr.subagents) {
          if (!prevSubIds.has(subagent.id)) {
            ops.push({
              type: "subagent-added",
              conversationId: curr.id,
              subagent,
            });
          }
        }
      }
    }

    return ops;
  }

  isEnabled(): boolean {
    return this.emit !== null;
  }
}

function isAIResponseEntry(
  entry: EventConversationSnapshot["activityLog"][number] | undefined,
): entry is EventAIResponseSnapshot {
  return entry?.type === "ai-response";
}

let instance: TreeChangeLogger | null = null;

export function getTreeChangeLogger(): TreeChangeLogger {
  instance ??= new TreeChangeLogger();
  return instance;
}
