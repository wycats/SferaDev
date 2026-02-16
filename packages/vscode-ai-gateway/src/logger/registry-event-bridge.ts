/**
 * Registry Event Bridge
 *
 * Translates AgentRegistryEvents into InvestigationEvents, bridging
 * the agent lifecycle into the unified event stream.
 *
 * This is the "first link" in the causality chain: registry events
 * carry the chatId that later appears as causedByChatId on tree changes.
 * Without these events in the unified stream, you can see "tree changed
 * because of chatId X" but can't see when X started, what model it used,
 * or how it completed.
 */

import * as vscode from "vscode";
import type { AgentRegistry, AgentRegistryEvent } from "../agent/index.js";
import type { InvestigationEvent } from "./investigation-events.js";
import { ulid } from "../utils/ulid.js";

/**
 * Subscribes to AgentRegistry events and emits corresponding
 * InvestigationEvents through the provided emit function.
 *
 * Returns a Disposable that unsubscribes from the registry.
 */
export function createRegistryEventBridge(
  registry: AgentRegistry,
  sessionId: string,
  emit: (event: InvestigationEvent) => void,
): vscode.Disposable {
  return registry.onDidChangeAgents((event: AgentRegistryEvent) => {
    const ts = new Date(event.timestamp).toISOString();
    const eventId = ulid();

    switch (event.type) {
      case "agent-started":
        emit({
          kind: "agent.started",
          eventId,
          ts,
          sessionId,
          conversationId: event.conversationId ?? event.agentId,
          chatId: event.chatId ?? event.agentId,
          parentChatId: event.parentChatId ?? null,
          agentTypeHash: event.agentTypeHash ?? null,
          agentId: event.agentId,
          canonicalAgentId: event.canonicalAgentId,
          isMain: event.isMain,
          isResume: event.isResume,
          parentConversationHash: event.parentConversationHash ?? null,
        });
        break;

      case "agent-completed":
        emit({
          kind: "agent.completed",
          eventId,
          ts,
          sessionId,
          conversationId: event.conversationId ?? event.agentId,
          chatId: event.chatId ?? event.agentId,
          agentId: event.agentId,
          canonicalAgentId: event.canonicalAgentId,
          usage: event.usage,
          turnCount: event.turnCount,
          summarizationDetected: event.summarizationDetected,
        });
        break;

      case "agent-errored":
        emit({
          kind: "agent.errored",
          eventId,
          ts,
          sessionId,
          conversationId: event.conversationId ?? event.agentId,
          chatId: event.chatId ?? event.agentId,
          agentId: event.agentId,
          canonicalAgentId: event.canonicalAgentId,
        });
        break;

      case "agent-updated":
        emit({
          kind: "agent.updated",
          eventId,
          ts,
          sessionId,
          conversationId: event.conversationId ?? event.agentId,
          chatId: event.chatId ?? event.agentId,
          agentId: event.agentId,
          canonicalAgentId: event.canonicalAgentId,
          updateType: event.updateType,
        });
        break;

      case "agent-removed":
        emit({
          kind: "agent.removed",
          eventId,
          ts,
          sessionId,
          conversationId: event.conversationId ?? event.agentId,
          chatId: event.chatId ?? event.agentId,
          agentId: event.agentId,
          reason: event.reason,
        });
        break;

      case "agents-cleared":
        // No individual agent context — skip or emit a lifecycle-like event.
        // agents-cleared is a bulk operation, not per-agent causality.
        break;
    }
  });
}
