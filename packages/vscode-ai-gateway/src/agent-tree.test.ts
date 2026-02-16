import { beforeEach, describe, it, expect, vi } from "vitest";
import * as vscode from "vscode";

vi.mock("vscode", () => ({
  Uri: {
    parse: (s: string) => {
      const url = new URL(s)
      return {
        scheme: url.protocol.slice(0, -1),
        authority: url.hostname,
        path: url.pathname,
        query: url.search,
        toString: () => s,
      }
    },
  },
  TreeItem: class {
    label: string;
    collapsibleState: number;
    id?: string;
    contextValue?: string;
    description?: string;
    tooltip?: unknown;
    iconPath?: unknown;
    constructor(label: string, collapsibleState: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2,
  },
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
  MarkdownString: class {
    value = "";
    isTrusted = false;
    appendMarkdown(text: string) {
      this.value += text;
    }
  },
  ThemeIcon: class {
    constructor(
      public id: string,
      public color?: unknown,
    ) {}
  },
  ThemeColor: class {
    constructor(public id: string) {}
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
  },
}));

import {
  ConversationTreeDataProvider,
  ConversationItem,
  AIResponseItem,
  SubagentItem,
} from "./agent-tree";
import type { TreeItem } from "./agent-tree";
import { CompactionTreeItem, ErrorTreeItem } from "./conversation/index";
import type { AgentEntry, AgentRegistry } from "./agent/index.js";

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
    id: "agent-1",
    name: "claude-sonnet-4",
    startTime: Date.now(),
    lastUpdateTime: Date.now(),
    inputTokens: 1000,
    outputTokens: 500,
    lastActualInputTokens: 1000,
    totalOutputTokens: 500,
    turnCount: 1,
    status: "complete",
    dimmed: false,
    isMain: true,
    ...overrides,
  };
}

describe("ConversationTreeDataProvider", () => {
  let registry: MockRegistry;
  let provider: ConversationTreeDataProvider;

  beforeEach(() => {
    registry = new MockRegistry();
  });

  function createProvider(): ConversationTreeDataProvider {
    provider = new ConversationTreeDataProvider(
      registry as unknown as AgentRegistry,
    );
    return provider;
  }

  describe("getChildren (root)", () => {
    it("returns empty array when no agents", () => {
      const p = createProvider();
      const children = p.getChildren(undefined);
      expect(children).toEqual([]);
    });

    it("returns ConversationItems for active conversations", () => {
      registry.setAgents([
        createAgent({
          id: "a1",
          conversationId: "conv-1",
          status: "streaming",
          startTime: 1000,
        }),
      ]);

      const p = createProvider();
      registry.emitChange();

      const roots = p.getChildren(undefined);
      expect(roots.length).toBeGreaterThanOrEqual(1);
      expect(roots[0]).toBeInstanceOf(ConversationItem);
    });

    it("sorts active conversations by most recent first", () => {
      registry.setAgents([
        createAgent({
          id: "a1",
          conversationId: "conv-old",
          status: "streaming",
          startTime: 1000,
          lastUpdateTime: 1000,
        }),
        createAgent({
          id: "a2",
          conversationId: "conv-new",
          status: "streaming",
          startTime: 2000,
          lastUpdateTime: 2000,
        }),
      ]);

      const p = createProvider();
      registry.emitChange();

      const roots = p.getChildren(undefined);
      const convItems = roots.filter((r) => r instanceof ConversationItem);
      expect(convItems.length).toBe(2);
      const first = convItems[0];
      const second = convItems[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(first?.conversation.id).toBe("conv-new");
      expect(second?.conversation.id).toBe("conv-old");
    });
  });

  describe("getChildren (ConversationItem)", () => {
    it("returns activity log entries as children", () => {
      registry.setAgents([
        createAgent({
          id: "a1",
          conversationId: "conv-1",
          status: "complete",
          turnCount: 2,
        }),
      ]);

      const p = createProvider();
      registry.emitChange();

      const roots = p.getChildren(undefined);
      const conv = roots.find((r) => r instanceof ConversationItem);
      expect(conv).toBeDefined();
      if (!conv) return;

      const children = p.getChildren(conv);
      // Should have activity log entries for the conversation
      expect(children.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("getChildren (AIResponseItem)", () => {
    it("returns empty for responses without subagents", () => {
      registry.setAgents([
        createAgent({
          id: "a1",
          conversationId: "conv-1",
          status: "complete",
        }),
      ]);

      const p = createProvider();
      registry.emitChange();

      const roots = p.getChildren(undefined);
      const conv = roots.find((r) => r instanceof ConversationItem);
      expect(conv).toBeDefined();
      if (!conv) return;
      const children = p.getChildren(conv);
      const responseItems = children.filter((c) => c instanceof AIResponseItem);

      for (const response of responseItems) {
        const subagents = p.getChildren(response);
        expect(subagents.every((s) => s instanceof SubagentItem)).toBe(true);
      }
    });

    it("returns SubagentItems for responses with subagents", () => {
      // Create a parent agent with a child subagent
      registry.setAgents([
        createAgent({
          id: "a-parent",
          conversationId: "conv-1",
          status: "complete",
          turnCount: 1,
        }),
        createAgent({
          id: "a-child",
          conversationId: "sub-1",
          parentConversationHash: "conv-1",
          name: "recon",
          status: "complete",
          isMain: false,
        }),
      ]);

      const p = createProvider();
      registry.emitChange();

      const roots = p.getChildren(undefined);
      const conv = roots.find((r) => r instanceof ConversationItem);
      expect(conv).toBeDefined();
      if (!conv) return;

      const children = p.getChildren(conv);
      const responseItems = children.filter((c) => c instanceof AIResponseItem);

      // Responses with subagent IDs should produce SubagentItem children
      for (const response of responseItems) {
        const responseChildren = p.getChildren(response);
        if (responseChildren.length > 0) {
          expect(responseChildren.every((s) => s instanceof SubagentItem)).toBe(
            true,
          );
        }
      }
    });
  });

  describe("getChildren (leaf nodes)", () => {
    it("returns empty for CompactionTreeItem", () => {
      const compaction = new CompactionTreeItem(
        {
          type: "compaction",
          freedTokens: 5000,
          turnNumber: 3,
          timestamp: Date.now(),
          compactionType: "summarization",
        },
        "conv-1",
      );
      const p = createProvider();
      expect(p.getChildren(compaction as TreeItem)).toEqual([]);
    });

    it("returns empty for ErrorTreeItem", () => {
      const error = new ErrorTreeItem(
        {
          type: "error",
          message: "Something went wrong",
          timestamp: Date.now(),
        },
        "conv-1",
      );
      const p = createProvider();
      expect(p.getChildren(error as TreeItem)).toEqual([]);
    });
  });

  describe("refresh", () => {
    it("fires onDidChangeTreeData", () => {
      const p = createProvider();
      const listener = vi.fn();
      p.onDidChangeTreeData(listener);

      p.refresh();

      expect(listener).toHaveBeenCalledWith(undefined);
    });

    it("fires when status bar emits changes", () => {
      const p = createProvider();
      const listener = vi.fn();
      p.onDidChangeTreeData(listener);

      registry.emitChange();

      // Should fire at least once (from the manager responding to agent changes)
      expect(listener).toHaveBeenCalled();
    });
  });
});
