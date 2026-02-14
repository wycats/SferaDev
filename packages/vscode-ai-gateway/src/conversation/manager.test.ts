import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  EventEmitter: class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire(data: T) {
      for (const listener of this.listeners) {
        listener(data);
      }
    }
    dispose() {}
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
  },
}));

import * as vscode from "vscode";
import { ConversationManager } from "./manager";
import type { AgentEntry } from "../status-bar";
import type { TokenStatusBar } from "../status-bar";

class MockStatusBar {
  private emitter = new vscode.EventEmitter<void>();
  private agents: AgentEntry[] = [];
  onDidChangeAgents = this.emitter.event;

  setAgents(agents: AgentEntry[]): void {
    this.agents = agents;
  }

  getAgents(): AgentEntry[] {
    return this.agents;
  }

  emitChange(): void {
    this.emitter.fire();
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

describe("ConversationManager", () => {
  let statusBar: MockStatusBar;

  beforeEach(() => {
    statusBar = new MockStatusBar();
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

    statusBar.setAgents([root, child]);
    const manager = new ConversationManager(
      statusBar as unknown as TokenStatusBar,
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

    statusBar.setAgents([agent]);
    const manager = new ConversationManager(
      statusBar as unknown as TokenStatusBar,
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

    statusBar.emitChange();

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

    statusBar.setAgents([agent]);
    const manager = new ConversationManager(
      statusBar as unknown as TokenStatusBar,
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
    statusBar.emitChange();

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

    statusBar.setAgents([root, child, grandchild]);
    const manager = new ConversationManager(
      statusBar as unknown as TokenStatusBar,
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

    statusBar.setAgents([agent]);
    const manager = new ConversationManager(
      statusBar as unknown as TokenStatusBar,
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

    statusBar.setAgents([agent]);
    const manager = new ConversationManager(
      statusBar as unknown as TokenStatusBar,
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

    statusBar.setAgents([agent]);
    const manager = new ConversationManager(
      statusBar as unknown as TokenStatusBar,
    );

    let conversation = manager.getConversations()[0];
    expect(conversation?.status).toBe("active");

    // 5 minutes + 1 second to exceed the idle threshold
    agent.lastUpdateTime = now.getTime() - (5 * 60 * 1000 + 1000);
    statusBar.emitChange();

    conversation = manager.getConversations()[0];
    expect(conversation?.status).toBe("idle");

    vi.useRealTimers();
  });
});
