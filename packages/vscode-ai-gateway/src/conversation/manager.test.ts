import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  EventEmitter: class EventEmitter<T> {
    private listeners: ((e: T) => void)[] = [];
    event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return {
        dispose: () => {
          /* noop */
        },
      };
    };
    fire(data: T) {
      for (const listener of this.listeners) {
        listener(data);
      }
    }
    dispose() {
      /* noop */
    }
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
  },
}));

import * as vscode from "vscode";
import { ConversationManager } from "./manager";
import type { AgentEntry, AgentRegistry } from "../agent/index.js";

class MockRegistry {
  private emitter = new vscode.EventEmitter<{
    type: "agents-cleared";
    sequence: number;
    timestamp: number;
  }>();
  private agents: AgentEntry[] = [];
  onDidChangeAgents = this.emitter.event;

  setAgents(agents: AgentEntry[]): void {
    this.agents = agents;
  }

  getAgents(): AgentEntry[] {
    return this.agents;
  }

  emitChange(): void {
    this.emitter.fire({ type: "agents-cleared", sequence: 0, timestamp: 0 });
  }

  syncAgentTurnCount(): void {
    // No-op for tests.
  }
}

function createAgent(overrides: Partial<AgentEntry> = {}): AgentEntry {
  return {
    id: "agent-id",
    name: "agent",
    startTime: 1000,
    lastUpdateTime: 1000,
    inputTokens: 100,
    outputTokens: 50,
    lastActualInputTokens: 100,
    totalOutputTokens: 50,
    turnCount: 1,
    status: "complete",
    dimmed: false,
    isMain: true,
    ...overrides,
  };
}

/** Get the first conversation from the manager, asserting it exists. */
function firstConversation(manager: ConversationManager) {
  const conversations = manager.getConversations();
  const first = conversations[0];
  expect(first).toBeDefined();
  if (!first) throw new Error("Expected at least one conversation");
  return first;
}

describe("ConversationManager", () => {
  let registry: MockRegistry;

  beforeEach(() => {
    registry = new MockRegistry();
  });

  it("builds conversations with subagent hierarchy", () => {
    const root = createAgent({
      id: "root-agent",
      conversationId: "conv-1",
      name: "main",
      generatedTitle: "Main Task",
      firstUserMessagePreview: "Preview text",
      modelId: "model-1",
      maxInputTokens: 1000,
      inputTokens: 500,
      outputTokens: 120,
      totalOutputTokens: 300,
      turnCount: 2,
      lastActualInputTokens: 500,
      lastUpdateTime: 2000,
    });

    const child = createAgent({
      id: "child-agent",
      conversationId: "conv-2",
      parentConversationHash: "conv-1",
      name: "child",
      isMain: false,
      turnCount: 1,
      inputTokens: 200,
      outputTokens: 80,
    });

    registry.setAgents([root, child]);
    const manager = new ConversationManager(
      registry as unknown as AgentRegistry,
    );

    const conversations = manager.getConversations();
    expect(conversations).toHaveLength(1);

    const conversation = conversations[0];
    expect(conversation?.id).toBe("conv-1");
    expect(conversation?.title).toBe("Main Task");
    expect(conversation?.workspaceFolder).toBe("/workspace");
    expect(conversation?.subagents).toHaveLength(1);
    expect(conversation?.subagents[0]?.conversationId).toBe("conv-2");
  });

  it("tracks compaction events across updates", () => {
    const agent = createAgent({
      id: "root-agent",
      conversationId: "conv-1",
      summarizationReduction: 200,
      turnCount: 2,
    });

    registry.setAgents([agent]);
    const manager = new ConversationManager(
      registry as unknown as AgentRegistry,
    );

    let conversation = manager.getConversations()[0];
    expect(conversation?.compactionEvents).toHaveLength(1);
    expect(conversation?.compactionEvents[0]?.type).toBe("summarization");
    expect(conversation?.compactionEvents[0]?.freedTokens).toBe(200);

    agent.summarizationReduction = 300;
    agent.contextManagement = {
      appliedEdits: [
        { type: "clear_tool_uses_20250919", clearedInputTokens: 120 },
      ],
    };

    registry.emitChange();

    conversation = manager.getConversations()[0];
    expect(conversation?.compactionEvents).toHaveLength(3);
    expect(conversation?.compactionEvents[1]?.type).toBe("summarization");
    expect(conversation?.compactionEvents[1]?.freedTokens).toBe(100);
    expect(conversation?.compactionEvents[2]?.type).toBe("context_management");
    expect(conversation?.compactionEvents[2]?.freedTokens).toBe(120);
  });

  it("tracks per-turn context management edits (not cumulative)", () => {
    // Context management edits are replaced each turn, not accumulated
    const agent = createAgent({
      id: "root-agent",
      conversationId: "conv-1",
      turnCount: 1,
      contextManagement: {
        appliedEdits: [
          { type: "clear_tool_uses_20250919", clearedInputTokens: 100 },
        ],
      },
    });

    registry.setAgents([agent]);
    const manager = new ConversationManager(
      registry as unknown as AgentRegistry,
    );

    let conversation = manager.getConversations()[0];
    expect(conversation?.compactionEvents).toHaveLength(1);
    expect(conversation?.compactionEvents[0]?.freedTokens).toBe(100);

    // Turn 2: Different context management edits (API replaces, not accumulates)
    agent.turnCount = 2;
    agent.contextManagement = {
      appliedEdits: [
        { type: "clear_thinking_20251015", clearedInputTokens: 50 },
      ],
    };
    registry.emitChange();

    conversation = manager.getConversations()[0];
    // Should have 2 events: one from turn 1 (100), one from turn 2 (50)
    expect(conversation?.compactionEvents).toHaveLength(2);
    expect(conversation?.compactionEvents[1]?.freedTokens).toBe(50);
    expect(conversation?.compactionEvents[1]?.type).toBe("context_management");
  });

  it("builds multi-level nested subagent hierarchy", () => {
    const root = createAgent({
      id: "root",
      conversationId: "conv-root",
      name: "main",
    });

    const child = createAgent({
      id: "child",
      conversationId: "conv-child",
      parentConversationHash: "conv-root",
      name: "recon",
      isMain: false,
    });

    const grandchild = createAgent({
      id: "grandchild",
      conversationId: "conv-grandchild",
      parentConversationHash: "conv-child",
      name: "recon-worker",
      isMain: false,
    });

    registry.setAgents([root, child, grandchild]);
    const manager = new ConversationManager(
      registry as unknown as AgentRegistry,
    );

    const conversations = manager.getConversations();
    expect(conversations).toHaveLength(1);

    const conversation = conversations[0];
    expect(conversation?.subagents).toHaveLength(1);
    expect(conversation?.subagents[0]?.name).toBe("recon");
    expect(conversation?.subagents[0]?.children).toHaveLength(1);
    expect(conversation?.subagents[0]?.children[0]?.name).toBe("recon-worker");
  });

  it("maps streaming status to active", () => {
    const agent = createAgent({
      id: "root",
      conversationId: "conv-1",
      status: "streaming",
    });

    registry.setAgents([agent]);
    const manager = new ConversationManager(
      registry as unknown as AgentRegistry,
    );

    const conversation = manager.getConversations()[0];
    expect(conversation?.status).toBe("active");
  });

  it("maps error status to idle", () => {
    const agent = createAgent({
      id: "root",
      conversationId: "conv-1",
      status: "error",
    });

    registry.setAgents([agent]);
    const manager = new ConversationManager(
      registry as unknown as AgentRegistry,
    );

    const conversation = manager.getConversations()[0];
    expect(conversation?.status).toBe("idle");
  });

  it("maps conversation status based on activity", () => {
    vi.useFakeTimers();
    const now = new Date("2026-02-13T00:00:00Z");
    vi.setSystemTime(now);

    const agent = createAgent({
      id: "root-agent",
      conversationId: "conv-1",
      status: "complete",
      lastUpdateTime: now.getTime(),
    });

    registry.setAgents([agent]);
    const manager = new ConversationManager(
      registry as unknown as AgentRegistry,
    );

    let conversation = manager.getConversations()[0];
    expect(conversation?.status).toBe("active");

    // 5 minutes + 1 second to exceed the idle threshold
    agent.lastUpdateTime = now.getTime() - (5 * 60 * 1000 + 1000);
    registry.emitChange();

    conversation = manager.getConversations()[0];
    expect(conversation?.status).toBe("idle");

    vi.useRealTimers();
  });

  it("builds activity log with message/response entries on turnCount increase", () => {
    const agent = createAgent({
      turnCount: 1,
      outputTokens: 50,
      status: "complete",
    });
    registry.setAgents([agent]);
    const manager = new ConversationManager(
      registry as unknown as AgentRegistry,
    );

    let conversation = firstConversation(manager);
    expect(conversation.activityLog).toHaveLength(2);
    expect(conversation.activityLog[0]).toMatchObject({
      type: "user-message",
      sequenceNumber: 1,
    });
    expect(conversation.activityLog[1]).toMatchObject({
      type: "ai-response",
      sequenceNumber: 1,
      state: "pending-characterization",
      tokenContribution: 50,
    });

    // Simulate a second turn
    agent.turnCount = 2;
    agent.outputTokens = 80;
    registry.emitChange();

    conversation = firstConversation(manager);
    expect(conversation.activityLog).toHaveLength(4);
    const response = conversation.activityLog.find(
      (entry) => entry.type === "ai-response" && entry.sequenceNumber === 2,
    );
    expect(response).toMatchObject({
      type: "ai-response",
      sequenceNumber: 2,
      state: "pending-characterization",
      tokenContribution: 80,
    });
  });

  it("marks latest response as streaming when agent is streaming", () => {
    const agent = createAgent({ turnCount: 1, status: "streaming" });
    registry.setAgents([agent]);
    const manager = new ConversationManager(
      registry as unknown as AgentRegistry,
    );

    const conversation = firstConversation(manager);
    const response = conversation.activityLog.find(
      (entry) => entry.type === "ai-response" && entry.sequenceNumber === 1,
    );
    expect(response).toMatchObject({
      type: "ai-response",
      sequenceNumber: 1,
      state: "streaming",
    });
  });

  it("creates activity log entries when streaming starts (turnCount=0)", () => {
    // When streaming starts, turnCount is still 0 (incremented on completion)
    const agent = createAgent({ turnCount: 0, status: "streaming" });
    registry.setAgents([agent]);
    const manager = new ConversationManager(
      registry as unknown as AgentRegistry,
    );

    const conversation = firstConversation(manager);
    expect(conversation.activityLog).toHaveLength(2);

    const userMessage = conversation.activityLog.find(
      (entry) => entry.type === "user-message" && entry.sequenceNumber === 1,
    );
    expect(userMessage).toMatchObject({
      type: "user-message",
      sequenceNumber: 1,
    });

    const response = conversation.activityLog.find(
      (entry) => entry.type === "ai-response" && entry.sequenceNumber === 1,
    );
    expect(response).toMatchObject({
      type: "ai-response",
      sequenceNumber: 1,
      state: "streaming",
    });
  });

  it("finalizes streaming response when agent completes", () => {
    const agent = createAgent({
      turnCount: 1,
      status: "streaming",
      outputTokens: 0,
    });
    registry.setAgents([agent]);
    const manager = new ConversationManager(
      registry as unknown as AgentRegistry,
    );

    let conversation = firstConversation(manager);
    const streamingResponse = conversation.activityLog.find(
      (entry) => entry.type === "ai-response" && entry.sequenceNumber === 1,
    );
    expect(streamingResponse).toMatchObject({ state: "streaming" });

    // Agent completes
    agent.status = "complete";
    agent.outputTokens = 120;
    registry.emitChange();

    conversation = firstConversation(manager);
    const response = conversation.activityLog.find(
      (entry) => entry.type === "ai-response" && entry.sequenceNumber === 1,
    );
    expect(response).toMatchObject({
      state: "pending-characterization",
      tokenContribution: 120,
    });
  });

  it("nests streaming response under previous user message (no phantom)", () => {
    // Simulate: turn 1 completed, then agent starts streaming turn 2.
    // turnCount stays at 1 until the new turn completes.
    const agent = createAgent({
      turnCount: 1,
      status: "complete",
      outputTokens: 50,
    });
    registry.setAgents([agent]);
    const manager = new ConversationManager(
      registry as unknown as AgentRegistry,
    );

    // Verify turn 1 is fully created
    let conversation = firstConversation(manager);
    expect(conversation.activityLog).toHaveLength(2);
    expect(conversation.activityLog[0]).toMatchObject({
      type: "user-message",
      sequenceNumber: 1,
    });
    expect(conversation.activityLog[1]).toMatchObject({
      type: "ai-response",
      sequenceNumber: 1,
      state: "pending-characterization",
    });

    // Agent starts streaming a new turn (turnCount unchanged)
    agent.status = "streaming";
    agent.outputTokens = 0;
    registry.emitChange();

    conversation = firstConversation(manager);
    // Should have 3 entries: UserMessage(1), AIResponse(1), AIResponse(2, streaming)
    // NO phantom UserMessage(2) — the streaming response nests under UserMessage(1)
    expect(conversation.activityLog).toHaveLength(3);

    const userMessages = conversation.activityLog.filter(
      (e) => e.type === "user-message",
    );
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]).toMatchObject({
      type: "user-message",
      sequenceNumber: 1,
    });

    const streamingResponse = conversation.activityLog.find(
      (e) => e.type === "ai-response" && e.sequenceNumber === 2,
    );
    expect(streamingResponse).toMatchObject({
      type: "ai-response",
      sequenceNumber: 2,
      state: "streaming",
    });
  });

  it("streaming response moves to new user message on turn completion", () => {
    // Full lifecycle: turn 1 complete → streaming turn 2 → turn 2 complete
    const agent = createAgent({
      turnCount: 1,
      status: "complete",
      outputTokens: 50,
    });
    registry.setAgents([agent]);
    const manager = new ConversationManager(
      registry as unknown as AgentRegistry,
    );

    // Start streaming turn 2
    agent.status = "streaming";
    agent.outputTokens = 0;
    registry.emitChange();

    let conversation = firstConversation(manager);
    // During streaming: UserMessage(1), AIResponse(1), AIResponse(2, streaming)
    expect(conversation.activityLog).toHaveLength(3);
    expect(
      conversation.activityLog.filter((e) => e.type === "user-message"),
    ).toHaveLength(1);

    // Turn 2 completes: turnCount increments
    agent.turnCount = 2;
    agent.status = "complete";
    agent.outputTokens = 120;
    registry.emitChange();

    conversation = firstConversation(manager);
    // After completion: UserMessage(1), AIResponse(1), UserMessage(2), AIResponse(2)
    expect(conversation.activityLog).toHaveLength(4);

    const userMessages = conversation.activityLog.filter(
      (e) => e.type === "user-message",
    );
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]).toMatchObject({ sequenceNumber: 1 });
    expect(userMessages[1]).toMatchObject({ sequenceNumber: 2 });

    const response2 = conversation.activityLog.find(
      (e) => e.type === "ai-response" && e.sequenceNumber === 2,
    );
    expect(response2).toMatchObject({
      state: "pending-characterization",
      tokenContribution: 120,
    });
  });

  it("skips skeleton entries when turnCount jumps (fork/reload)", () => {
    // After a fork or reload, turnCount can jump from a low value to a high
    // value. We should only create entries for the latest turn, not fill in
    // empty skeleton entries for all intermediate turns.
    const agent = createAgent({
      turnCount: 50,
      status: "complete",
      outputTokens: 200,
    });
    registry.setAgents([agent]);
    const manager = new ConversationManager(
      registry as unknown as AgentRegistry,
    );

    const conversation = firstConversation(manager);
    // Should only have entries for turn 50, not turns 1-50
    expect(conversation.activityLog).toHaveLength(2);

    const userMessages = conversation.activityLog.filter(
      (e) => e.type === "user-message",
    );
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]).toMatchObject({ sequenceNumber: 50 });

    const responses = conversation.activityLog.filter(
      (e) => e.type === "ai-response",
    );
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      sequenceNumber: 50,
      state: "pending-characterization",
    });
  });

  it("creates entries for consecutive turns (tool continuations)", () => {
    // When turnCount advances by 1 (normal progression), entries should
    // be created for each turn.
    const agent = createAgent({
      turnCount: 1,
      status: "complete",
      outputTokens: 50,
    });
    registry.setAgents([agent]);
    const manager = new ConversationManager(
      registry as unknown as AgentRegistry,
    );

    // Turn 2 completes (tool continuation)
    agent.turnCount = 2;
    agent.outputTokens = 80;
    registry.emitChange();

    const conversation = firstConversation(manager);
    // Should have entries for both turns 1 and 2
    expect(conversation.activityLog).toHaveLength(4);

    const userMessages = conversation.activityLog.filter(
      (e) => e.type === "user-message",
    );
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]).toMatchObject({ sequenceNumber: 1 });
    expect(userMessages[1]).toMatchObject({ sequenceNumber: 2 });
  });

  it("adds error entry when agent errors", () => {
    const agent = createAgent({ turnCount: 1, status: "error" });
    registry.setAgents([agent]);
    const manager = new ConversationManager(
      registry as unknown as AgentRegistry,
    );

    const conversation = firstConversation(manager);
    // Should have message + response + error
    const errors = conversation.activityLog.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      type: "error",
      turnNumber: 1,
      message: "Request failed",
    });
  });

  it("does not duplicate error entries on subsequent rebuilds", () => {
    const agent = createAgent({ turnCount: 1, status: "error" });
    registry.setAgents([agent]);
    const manager = new ConversationManager(
      registry as unknown as AgentRegistry,
    );

    // Trigger rebuild again
    registry.emitChange();
    registry.emitChange();

    const conversation = firstConversation(manager);
    const errors = conversation.activityLog.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
  });

  it("syncs compaction events into activity log", () => {
    const agent = createAgent({
      turnCount: 2,
      summarizationReduction: 5000,
    });
    registry.setAgents([agent]);
    const manager = new ConversationManager(
      registry as unknown as AgentRegistry,
    );

    const conversation = firstConversation(manager);
    const compactions = conversation.activityLog.filter(
      (e) => e.type === "compaction",
    );
    expect(compactions).toHaveLength(1);
    expect(compactions[0]).toMatchObject({
      type: "compaction",
      compactionType: "summarization",
      freedTokens: 5000,
    });
  });

  it("updates response characterization", () => {
    const agent = createAgent({ turnCount: 1 });
    registry.setAgents([agent]);
    const manager = new ConversationManager(
      registry as unknown as AgentRegistry,
    );

    const conversationId = firstConversation(manager).id;
    manager.updateTurnCharacterization(conversationId, 1, "Fixed login bug");

    const conversation = firstConversation(manager);
    const response = conversation.activityLog.find(
      (e) => e.type === "ai-response" && e.sequenceNumber === 1,
    );
    expect(response).toMatchObject({
      type: "ai-response",
      characterization: "Fixed login bug",
      state: "characterized",
    });
  });

  it("sets user message preview", () => {
    const agent = createAgent({ turnCount: 1 });
    registry.setAgents([agent]);
    const manager = new ConversationManager(
      registry as unknown as AgentRegistry,
    );

    const conversationId = firstConversation(manager).id;
    manager.setUserMessagePreview(
      conversationId,
      1,
      "How do I fix the login bug?",
    );

    const conversation = firstConversation(manager);
    const userMessage = conversation.activityLog.find(
      (e) => e.type === "user-message" && e.sequenceNumber === 1,
    );
    expect(userMessage).toMatchObject({
      type: "user-message",
      preview: "How do I fix the login bug?",
    });
  });

  it("sets tools used on AI response", () => {
    const agent = createAgent({ turnCount: 1 });
    registry.setAgents([agent]);
    const manager = new ConversationManager(
      registry as unknown as AgentRegistry,
    );

    const conversationId = firstConversation(manager).id;
    manager.setToolsUsed(conversationId, 1, [
      "read_file",
      "grep_search",
      "replace_string_in_file",
    ]);

    const conversation = firstConversation(manager);
    const response = conversation.activityLog.find(
      (e) => e.type === "ai-response" && e.sequenceNumber === 1,
    );
    expect(response).toMatchObject({
      type: "ai-response",
      toolsUsed: ["read_file", "grep_search", "replace_string_in_file"],
    });
  });

  it("sets tool calls with full details on AI response", () => {
    const agent = createAgent({ turnCount: 1 });
    registry.setAgents([agent]);
    const manager = new ConversationManager(
      registry as unknown as AgentRegistry,
    );

    const conversationId = firstConversation(manager).id;
    manager.setToolCalls(conversationId, 1, [
      { callId: "call-1", name: "read_file", args: { filePath: "/src/foo.ts", startLine: 1, endLine: 50 } },
      { callId: "call-2", name: "grep_search", args: { query: "handleFork", isRegexp: false } },
    ]);

    const conversation = firstConversation(manager);
    const response = conversation.activityLog.find(
      (e) => e.type === "ai-response" && e.sequenceNumber === 1,
    );
    expect(response).toMatchObject({
      type: "ai-response",
      toolCalls: [
        { callId: "call-1", name: "read_file", args: { filePath: "/src/foo.ts", startLine: 1, endLine: 50 } },
        { callId: "call-2", name: "grep_search", args: { query: "handleFork", isRegexp: false } },
      ],
      // toolsUsed is derived from toolCalls
      toolsUsed: ["read_file", "grep_search"],
    });
  });

  it("does not overwrite existing user message preview", () => {
    const agent = createAgent({
      turnCount: 2,
    });
    registry.setAgents([agent]);
    const manager = new ConversationManager(
      registry as unknown as AgentRegistry,
    );

    const conversationId = firstConversation(manager).id;
    // First set should work (turn 2 has no preview initially)
    manager.setUserMessagePreview(conversationId, 2, "First preview");
    // Second set should be ignored (preview already exists)
    manager.setUserMessagePreview(conversationId, 2, "Second preview");

    const conversation = firstConversation(manager);
    const userMessage = conversation.activityLog.find(
      (e) => e.type === "user-message" && e.sequenceNumber === 2,
    );
    expect(userMessage).toMatchObject({
      type: "user-message",
      preview: "First preview",
    });
  });
});
