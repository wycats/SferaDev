import { beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Hoisted mocks
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("vscode", () => ({
  Disposable: class {
    constructor(private fn: () => void) {}
    dispose() {
      this.fn();
    }
  },
}));

import type { AgentRegistryEvent } from "../agent/registry.js";
import type { InvestigationEvent } from "./investigation-events.js";
import { createRegistryEventBridge } from "./registry-event-bridge.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

type Listener = (event: AgentRegistryEvent) => void;

function createMockRegistry() {
  const listeners: Listener[] = [];
  return {
    onDidChangeAgents: (listener: Listener) => {
      listeners.push(listener);
      return { dispose: () => {} };
    },
    fire(event: AgentRegistryEvent) {
      for (const l of listeners) l(event);
    },
  };
}

function baseEvent(
  seq: number,
): Pick<AgentRegistryEvent, "sequence" | "timestamp"> {
  return { sequence: seq, timestamp: Date.now() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("createRegistryEventBridge", () => {
  let registry: ReturnType<typeof createMockRegistry>;
  let emitted: InvestigationEvent[];
  const sessionId = "test-session";

  beforeEach(() => {
    registry = createMockRegistry();
    emitted = [];
    createRegistryEventBridge(
      registry as any,
      sessionId,
      (e) => emitted.push(e),
    );
  });

  it("translates agent-started to agent.started", () => {
    registry.fire({
      ...baseEvent(1),
      type: "agent-started",
      agentId: "a1",
      canonicalAgentId: "a1",
      chatId: "chat-1",
      parentChatId: undefined,
      conversationId: "conv-1",
      agentTypeHash: "hash-1",
      isMain: true,
      isResume: false,
      parentConversationHash: null,
    });

    expect(emitted).toHaveLength(1);
    const e = emitted[0] as any;
    expect(e.kind).toBe("agent.started");
    expect(e.sessionId).toBe(sessionId);
    expect(e.agentId).toBe("a1");
    expect(e.chatId).toBe("chat-1");
    expect(e.isMain).toBe(true);
    expect(e.eventId).toBeTruthy();
  });

  it("translates agent-completed to agent.completed", () => {
    registry.fire({
      ...baseEvent(2),
      type: "agent-completed",
      agentId: "a1",
      canonicalAgentId: "a1",
      chatId: "chat-1",
      conversationId: "conv-1",
      usage: { inputTokens: 100, outputTokens: 50 },
      turnCount: 3,
      summarizationDetected: false,
    });

    expect(emitted).toHaveLength(1);
    const e = emitted[0] as any;
    expect(e.kind).toBe("agent.completed");
    expect(e.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(e.turnCount).toBe(3);
  });

  it("translates agent-errored to agent.errored", () => {
    registry.fire({
      ...baseEvent(3),
      type: "agent-errored",
      agentId: "a1",
      canonicalAgentId: "a1",
      chatId: "chat-1",
      conversationId: "conv-1",
    });

    expect(emitted).toHaveLength(1);
    expect((emitted[0] as any).kind).toBe("agent.errored");
  });

  it("translates agent-updated to agent.updated", () => {
    registry.fire({
      ...baseEvent(4),
      type: "agent-updated",
      agentId: "a1",
      canonicalAgentId: "a1",
      chatId: "chat-1",
      conversationId: "conv-1",
      updateType: "turn-count-sync",
    });

    expect(emitted).toHaveLength(1);
    const e = emitted[0] as any;
    expect(e.kind).toBe("agent.updated");
    expect(e.updateType).toBe("turn-count-sync");
  });

  it("translates agent-removed to agent.removed", () => {
    registry.fire({
      ...baseEvent(5),
      type: "agent-removed",
      agentId: "a1",
      chatId: "chat-1",
      conversationId: "conv-1",
      reason: "aged",
    });

    expect(emitted).toHaveLength(1);
    const e = emitted[0] as any;
    expect(e.kind).toBe("agent.removed");
    expect(e.reason).toBe("aged");
  });

  it("skips agents-cleared events", () => {
    registry.fire({
      ...baseEvent(6),
      type: "agents-cleared",
    });

    expect(emitted).toHaveLength(0);
  });

  it("falls back to agentId when chatId/conversationId are undefined", () => {
    registry.fire({
      ...baseEvent(7),
      type: "agent-started",
      agentId: "a1",
      canonicalAgentId: "a1",
      chatId: undefined,
      parentChatId: undefined,
      conversationId: undefined,
      agentTypeHash: undefined,
      isMain: false,
      isResume: false,
      parentConversationHash: null,
    });

    const e = emitted[0] as any;
    expect(e.chatId).toBe("a1");
    expect(e.conversationId).toBe("a1");
  });

  it("generates unique eventIds for each event", () => {
    for (let i = 0; i < 10; i++) {
      registry.fire({
        ...baseEvent(i),
        type: "agent-started",
        agentId: `a${i}`,
        canonicalAgentId: `a${i}`,
        chatId: `chat-${i}`,
        parentChatId: undefined,
        conversationId: `conv-${i}`,
        agentTypeHash: "hash",
        isMain: true,
        isResume: false,
        parentConversationHash: null,
      });
    }

    const ids = emitted.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(10);
  });
});
