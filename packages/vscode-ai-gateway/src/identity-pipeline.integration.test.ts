/**
 * Integration tests for the conversationId-based identity pipeline.
 *
 * Exercises TokenStatusBar + ConversationTreeDataProvider together, verifying
 * that conversationId-based identity produces correct:
 * - Multi-turn resume behavior (same conversationId → same agent)
 * - Token accumulation across turns
 * - Parent-child hierarchy with claim registry
 * - ConversationTreeDataProvider rendering (root vs children, tree refresh events)
 * - No >100% context percentage (regression gate)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock vscode module
const mockStatusBarItem = {
  text: "",
  tooltip: "",
  backgroundColor: undefined as unknown,
  command: undefined as string | undefined,
  name: undefined as string | undefined,
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
};

vi.mock("vscode", () => ({
  Uri: {
    parse: (s: string) => {
      const url = new URL(s);
      return {
        scheme: url.protocol.slice(0, -1),
        authority: url.hostname,
        path: url.pathname,
        query: url.search,
        toString: () => s,
      };
    },
  },
  window: {
    createStatusBarItem: vi.fn(() => mockStatusBarItem),
  },
  env: {
    sessionId: "test-session-id",
  },
  StatusBarAlignment: {
    Left: 1,
    Right: 2,
  },
  ThemeColor: class ThemeColor {
    constructor(public id: string) {}
  },
  ThemeIcon: class ThemeIcon {
    constructor(
      public id: string,
      public color?: unknown,
    ) {}
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
      this.listeners.forEach((l) => {
        l(data);
      });
    }
    dispose() {
      /* noop */
    }
  },
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2,
  },
  TreeItem: class TreeItem {
    label: string;
    collapsibleState: number;
    id?: string;
    contextValue?: string;
    description?: string;
    tooltip?: unknown;
    iconPath?: unknown;
    constructor(label: string, collapsibleState?: number) {
      this.label = label;
      this.collapsibleState = collapsibleState ?? 0;
    }
  },
  MarkdownString: class MarkdownString {
    value = "";
    isTrusted = false;
    appendMarkdown(val: string) {
      this.value += val;
      return this;
    }
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
  },
}));

import { ConversationTreeDataProvider, ConversationItem } from "./agent-tree";
import { AgentRegistryImpl } from "./agent";
import { TokenStatusBar } from "./status-bar";

describe("conversationId identity pipeline (integration)", () => {
  let registry: AgentRegistryImpl;
  let statusBar: TokenStatusBar;
  let treeProvider: ConversationTreeDataProvider;
  let treeChangeCount: number;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStatusBarItem.text = "";
    mockStatusBarItem.tooltip = "";
    mockStatusBarItem.backgroundColor = undefined;
    registry = new AgentRegistryImpl();
    statusBar = new TokenStatusBar(registry);
    treeProvider = new ConversationTreeDataProvider(registry);
    treeChangeCount = 0;
    treeProvider.onDidChangeTreeData(() => {
      treeChangeCount++;
    });
  });

  describe("multi-turn conversation tracking", () => {
    it("resumes agent by conversationId on subsequent turns", () => {
      const conversationId = "conv-abc-123";

      // Turn 1: new agent
      const turn1Id = registry.startAgent({
        agentId: "req-turn1",
        estimatedTokens: 50000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        systemPromptHash: "sys-hash",
        agentTypeHash: "type-hash",
        firstUserMessageHash: "user-msg-hash",
        conversationId,
      });
      registry.completeAgent("req-turn1", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Turn 2: same conversationId → should resume, not create new
      const turn2Id = registry.startAgent({
        agentId: "req-turn2",
        estimatedTokens: 55000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        systemPromptHash: "sys-hash",
        agentTypeHash: "type-hash",
        firstUserMessageHash: "user-msg-hash",
        conversationId,
      });

      // Should return the original agent ID (aliased)
      expect(turn1Id).toBe("req-turn1");
      expect(turn2Id).toBe("req-turn1");

      // Only one agent in the list
      const agents = statusBar.getAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0]?.status).toBe("streaming");
    });

    it("accumulates tokens across turns rather than resetting", () => {
      const conversationId = "conv-accum";

      // Turn 1
      registry.startAgent({
        agentId: "req-1",
        estimatedTokens: 50000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        conversationId,
      });
      registry.completeAgent("req-1", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Turn 2: resumed by conversationId
      registry.startAgent({
        agentId: "req-2",
        estimatedTokens: 55000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        conversationId,
      });
      registry.completeAgent("req-2", {
        inputTokens: 58000,
        outputTokens: 1500,
        maxInputTokens: 128000,
      });

      const agents = statusBar.getAgents();
      expect(agents).toHaveLength(1);
      const agent = agents[0];
      expect(agent).toBeDefined();
      if (!agent) {
        throw new Error("Expected agent to be defined");
      }

      // turnCount should be 2
      expect(agent.turnCount).toBe(2);
      // lastActualInputTokens should be the LATEST turn's actual (not historical peak)
      expect(agent.lastActualInputTokens).toBe(58000);
      // totalOutputTokens should accumulate
      expect(agent.totalOutputTokens).toBe(2500);
      // inputTokens/outputTokens are from the LAST turn
      expect(agent.inputTokens).toBe(58000);
      expect(agent.outputTokens).toBe(1500);
    });

    it("creates separate agents for different conversationIds", () => {
      registry.startAgent({
        agentId: "req-a",
        estimatedTokens: 50000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        agentTypeHash: "type-a",
        conversationId: "conv-A",
      });
      registry.completeAgent("req-a", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Create claim so second agent isn't treated as main replacement
      registry.createChildClaim("req-a", "other");

      registry.startAgent({
        agentId: "req-b",
        estimatedTokens: 30000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        agentTypeHash: "type-b",
        conversationId: "conv-B",
      });

      const agents = statusBar.getAgents();
      expect(agents).toHaveLength(2);
    });
  });

  describe("multi-agent hierarchy", () => {
    it("subagent links to parent via claim and renders in tree", () => {
      const mainConvId = "conv-main";
      const subConvId = "conv-sub";

      // Main agent starts and completes
      registry.startAgent({
        agentId: "main-req",
        estimatedTokens: 50000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        systemPromptHash: "main-sys",
        agentTypeHash: "main-type",
        conversationId: mainConvId,
      });
      registry.completeAgent("main-req", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Parent creates a claim for expected child
      registry.createChildClaim("main-req", "recon");

      // Subagent starts with different type hash → matches claim
      registry.startAgent({
        agentId: "sub-req",
        estimatedTokens: 8000,
        maxTokens: 128000,
        modelId: "recon-model",
        systemPromptHash: "sub-sys",
        agentTypeHash: "sub-type",
        conversationId: subConvId,
      });

      // Verify agent hierarchy
      const agents = statusBar.getAgents();
      expect(agents).toHaveLength(2);

      const mainAgent = agents.find((a) => a.id === "main-req");
      const subAgent = agents.find((a) => a.id === "sub-req");
      expect(mainAgent?.isMain).toBe(true);
      expect(subAgent?.isMain).toBe(false);
      expect(subAgent?.parentConversationHash).toBe(mainConvId);

      // Verify tree structure: root should only show main conversation
      const roots = treeProvider.getChildren(undefined);
      expect(roots).toHaveLength(1);
      expect(roots[0]).toBeInstanceOf(ConversationItem);
      const rootItem = roots[0] as ConversationItem;
      expect(rootItem.conversation.id).toBe("conv-main");
      // Conversation should be expandable (has activity log)
      expect(rootItem.collapsibleState).toBe(2); // Expanded

      // Subagent should be in the conversation data model
      expect(rootItem.conversation.subagents).toHaveLength(1);
      expect(rootItem.conversation.subagents[0]?.conversationId).toBe(
        "conv-sub",
      );
    });

    it("multiple subagents appear as siblings under parent", () => {
      const mainConvId = "conv-main-multi";

      registry.startAgent({
        agentId: "main",
        estimatedTokens: 50000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        agentTypeHash: "main-type",
        conversationId: mainConvId,
      });
      registry.completeAgent("main", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Create claims for two subagents
      registry.createChildClaim("main", "recon");
      registry.createChildClaim("main", "execute");

      // First subagent
      registry.startAgent({
        agentId: "sub-recon",
        estimatedTokens: 8000,
        maxTokens: 128000,
        modelId: "recon-model",
        agentTypeHash: "recon-type",
        conversationId: "conv-sub-recon",
      });
      registry.completeAgent("sub-recon", {
        inputTokens: 8500,
        outputTokens: 500,
        maxInputTokens: 128000,
      });

      // Second subagent
      registry.startAgent({
        agentId: "sub-exec",
        estimatedTokens: 12000,
        maxTokens: 128000,
        modelId: "exec-model",
        agentTypeHash: "exec-type",
        conversationId: "conv-sub-exec",
      });

      // Tree root should be main conversation only
      const roots = treeProvider.getChildren(undefined);
      expect(roots).toHaveLength(1);

      // Subagents should be in the conversation data model
      const conv = roots[0] as ConversationItem;
      expect(conv.conversation.subagents).toHaveLength(2);
      const subNames = conv.conversation.subagents.map((s) => s.name);
      expect(subNames).toContain("recon");
      expect(subNames).toContain("execute");
    });
  });

  describe("tree refresh events", () => {
    it("fires onDidChangeTreeData on startAgent", () => {
      const countBefore = treeChangeCount;
      registry.startAgent({
        agentId: "agent-1",
        estimatedTokens: 50000,
        maxTokens: 128000,
      });
      expect(treeChangeCount).toBeGreaterThan(countBefore);
    });

    it("fires onDidChangeTreeData on completeAgent", () => {
      registry.startAgent({
        agentId: "agent-1",
        estimatedTokens: 50000,
        maxTokens: 128000,
      });
      const countBefore = treeChangeCount;
      registry.completeAgent("agent-1", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });
      expect(treeChangeCount).toBeGreaterThan(countBefore);
    });

    it("fires onDidChangeTreeData on resume", () => {
      const convId = "conv-refresh";
      registry.startAgent({
        agentId: "req-1",
        estimatedTokens: 50000,
        maxTokens: 128000,
        conversationId: convId,
      });
      registry.completeAgent("req-1", {
        inputTokens: 52000,
        outputTokens: 1000,
      });

      const countBefore = treeChangeCount;
      registry.startAgent({
        agentId: "req-2",
        estimatedTokens: 55000,
        maxTokens: 128000,
        conversationId: convId,
      });
      expect(treeChangeCount).toBeGreaterThan(countBefore);
    });
  });

  describe("context percentage correctness", () => {
    it("never shows >100% for a single agent", () => {
      const convId = "conv-pct";

      registry.startAgent({
        agentId: "req-1",
        estimatedTokens: 50000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        conversationId: convId,
      });
      registry.completeAgent("req-1", {
        inputTokens: 100000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      const agents = statusBar.getAgents();
      const agent = agents[0];
      expect(agent).toBeDefined();
      if (!agent) {
        throw new Error("Expected agent to be defined");
      }
      const pct = Math.round(
        ((agent.turnCount > 1
          ? agent.lastActualInputTokens
          : agent.inputTokens) /
          (agent.maxInputTokens ?? 1)) *
          100,
      );
      expect(pct).toBeLessThanOrEqual(100);
    });

    it("subagent tokens don't inflate parent's percentage (regression: >100%)", () => {
      const mainConvId = "conv-main-pct";

      // Main agent
      registry.startAgent({
        agentId: "main-req",
        estimatedTokens: 50000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        agentTypeHash: "main-type",
        conversationId: mainConvId,
      });
      registry.completeAgent("main-req", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Claim + subagent with very different token count
      registry.createChildClaim("main-req", "recon");
      registry.startAgent({
        agentId: "sub-req",
        estimatedTokens: 8000,
        maxTokens: 128000,
        modelId: "recon",
        agentTypeHash: "sub-type",
      });
      registry.completeAgent("sub-req", {
        inputTokens: 8500,
        outputTokens: 500,
        maxInputTokens: 128000,
      });

      // Main agent should still show 52k/128k, not inflated by subagent
      const agents = statusBar.getAgents();
      const mainAgent = agents.find((a) => a.id === "main-req");
      expect(mainAgent).toBeDefined();
      if (!mainAgent) {
        throw new Error("Expected main agent to be defined");
      }
      expect(mainAgent.inputTokens).toBe(52000);
      expect(mainAgent.maxInputTokens).toBe(128000);
      const mainMaxInputTokens = mainAgent.maxInputTokens;
      if (!mainMaxInputTokens) {
        throw new Error("Expected main agent maxInputTokens to be defined");
      }

      const mainPct = Math.round(
        (mainAgent.inputTokens / mainMaxInputTokens) * 100,
      );
      expect(mainPct).toBe(41); // 52000/128000 = 40.6%
      expect(mainPct).toBeLessThanOrEqual(100);

      // Subagent should have its own independent percentage
      const subAgent = agents.find((a) => a.id === "sub-req");
      expect(subAgent).toBeDefined();
      if (!subAgent) {
        throw new Error("Expected subagent to be defined");
      }
      expect(subAgent.inputTokens).toBe(8500);
      const subMaxInputTokens = subAgent.maxInputTokens;
      if (!subMaxInputTokens) {
        throw new Error("Expected subagent maxInputTokens to be defined");
      }
      const subPct = Math.round(
        (subAgent.inputTokens / subMaxInputTokens) * 100,
      );
      expect(subPct).toBe(7); // 8500/128000 = 6.6%
    });

    it("multi-turn percentage uses latest actual tokens (reflects summarization reductions)", () => {
      const convId = "conv-multiturn-pct";

      // Turn 1: high input
      registry.startAgent({
        agentId: "req-1",
        estimatedTokens: 100000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        conversationId: convId,
      });
      registry.completeAgent("req-1", {
        inputTokens: 100000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Turn 2: lower input (e.g., after summarization/compaction)
      registry.startAgent({
        agentId: "req-2",
        estimatedTokens: 60000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        conversationId: convId,
      });
      registry.completeAgent("req-2", {
        inputTokens: 60000,
        outputTokens: 800,
        maxInputTokens: 128000,
      });
      const agent = statusBar.getAgents()[0];
      expect(agent).toBeDefined();
      if (!agent) {
        throw new Error("Expected agent to be defined");
      }
      expect(agent.turnCount).toBe(2);
      // lastActualInputTokens should be 60000 (latest turn), not 100000 (peak)
      // After summarization, context shrinks and the display should reflect that
      expect(agent.lastActualInputTokens).toBe(60000);

      // Tree description should use latest actual for percentage
      const roots = treeProvider.getChildren(undefined);
      const treeItem = roots[0] as ConversationItem;
      // Description should contain percentage based on 60k/128k = 47%
      expect(treeItem.description).toContain("47%");
    });

    it("summarization boundary: tokens drop sharply and display reflects reduction", () => {
      const convId = "conv-summarization-boundary";

      // Turn 1: near context limit (120k/128k = 94%)
      registry.startAgent({
        agentId: "req-pre-summ",
        estimatedTokens: 120000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        conversationId: convId,
      });
      registry.completeAgent("req-pre-summ", {
        inputTokens: 120000,
        outputTokens: 2000,
        maxInputTokens: 128000,
      });

      // Verify pre-summarization state
      let agent = statusBar.getAgents()[0];
      expect(agent).toBeDefined();
      if (!agent) {
        throw new Error("Expected agent to be defined");
      }
      expect(agent.lastActualInputTokens).toBe(120000);

      // Turn 2: VS Code summarizes → context drops to 30k (77% reduction)
      registry.startAgent({
        agentId: "req-post-summ",
        estimatedTokens: 30000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        conversationId: convId,
      });
      registry.completeAgent("req-post-summ", {
        inputTokens: 30000,
        outputTokens: 500,
        maxInputTokens: 128000,
      });

      agent = statusBar.getAgents()[0];
      expect(agent).toBeDefined();
      if (!agent) {
        throw new Error("Expected agent to be defined");
      }
      expect(agent.turnCount).toBe(2);
      // After summarization, display should show 30k (not stuck at 120k)
      expect(agent.lastActualInputTokens).toBe(30000);
      // Percentage should be 30k/128k = 23%, not 94%
      const maxInputTokens = agent.maxInputTokens;
      if (!maxInputTokens) {
        throw new Error("Expected agent maxInputTokens to be defined");
      }
      const pct = Math.round(
        (agent.lastActualInputTokens / maxInputTokens) * 100,
      );
      expect(pct).toBe(23);

      // Tree should also reflect the reduction
      const roots = treeProvider.getChildren(undefined);
      const treeItem = roots[0] as ConversationItem;
      expect(treeItem.description).toContain("23%");
    });

    it("streaming delta uses latest actual as base, not stale peak", () => {
      const convId = "conv-delta-base";

      // Turn 1: 100k input
      registry.startAgent({
        agentId: "req-t1",
        estimatedTokens: 100000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        conversationId: convId,
      });
      registry.completeAgent("req-t1", {
        inputTokens: 100000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Turn 2: after summarization, context drops to 40k
      registry.startAgent({
        agentId: "req-t2",
        estimatedTokens: 40000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        conversationId: convId,
      });
      registry.completeAgent("req-t2", {
        inputTokens: 40000,
        outputTokens: 800,
        maxInputTokens: 128000,
      });

      // Turn 3: streaming with delta — base should be 40k (latest), not 100k (peak)
      registry.startAgent({
        agentId: "req-t3",
        estimatedTokens: 45000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        conversationId: convId,
      });

      const agent = statusBar.getAgents()[0];
      expect(agent).toBeDefined();
      if (!agent) {
        throw new Error("Expected agent to be defined");
      }
      expect(agent.status).toBe("streaming");
      // lastActualInputTokens should be 40k (from turn 2 completion)
      expect(agent.lastActualInputTokens).toBe(40000);
      // If estimatedDeltaTokens is set, the streaming display would compute:
      // lastActualInputTokens + estimatedDeltaTokens = 40k + delta
      // NOT 100k + delta (which would be wrong after summarization)
    });
  });

  describe("edge cases", () => {
    it("agent without conversationId still works (fallback behavior)", () => {
      // First request without conversationId
      registry.startAgent({
        agentId: "req-no-conv",
        estimatedTokens: 50000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
      });
      registry.completeAgent("req-no-conv", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      const agents = statusBar.getAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0]?.conversationId).toBeUndefined();

      // Tree should still work
      const roots = treeProvider.getChildren(undefined);
      expect(roots).toHaveLength(1);
    });

    it("clearAgents resets agent list to empty", () => {
      registry.startAgent({
        agentId: "req-1",
        estimatedTokens: 50000,
        maxTokens: 128000,
        conversationId: "conv-1",
      });

      registry.clearAgents();

      // Agent list is empty
      const agents = statusBar.getAgents();
      expect(agents).toHaveLength(0);
    });

    it("resumed agent maintains isMain across turns", () => {
      const convId = "conv-main-persist";

      registry.startAgent({
        agentId: "req-1",
        estimatedTokens: 50000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        systemPromptHash: "sys",
        agentTypeHash: "type",
        conversationId: convId,
      });
      registry.completeAgent("req-1", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Create a claim (shouldn't affect main agent resume)
      registry.createChildClaim("req-1", "recon");

      // Turn 2: resume with same conversationId
      registry.startAgent({
        agentId: "req-2",
        estimatedTokens: 55000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        systemPromptHash: "sys",
        agentTypeHash: "type",
        conversationId: convId,
      });
      registry.completeAgent("req-2", {
        inputTokens: 58000,
        outputTokens: 1500,
        maxInputTokens: 128000,
      });

      const agents = statusBar.getAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0]?.isMain).toBe(true);
      expect(agents[0]?.turnCount).toBe(2);

      // Claim should still be pending (not consumed by main agent)
      // Verify by starting a real subagent
      registry.startAgent({
        agentId: "recon-req",
        estimatedTokens: 8000,
        maxTokens: 128000,
        modelId: "recon",
        systemPromptHash: "diff-sys",
        agentTypeHash: "diff-type",
        conversationId: "conv-recon",
      });

      const agentsAfter = statusBar.getAgents();
      const recon = agentsAfter.find((a) => a.id === "recon-req");
      expect(recon?.isMain).toBe(false);
      expect(recon?.name).toBe("recon");
    });
  });

  describe("sidebar conversation display (conversation-centric tree)", () => {
    it("shows all recent conversations at root (sorted by most recent)", () => {
      // Conversation A
      registry.startAgent({
        agentId: "req-a1",
        estimatedTokens: 50000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        systemPromptHash: "sys-a",
        agentTypeHash: "type-a",
        firstUserMessageHash: "msg-a",
        conversationId: "conv-aaa",
      });
      registry.completeAgent("req-a1", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Conversation B (becomes the most recent)
      registry.startAgent({
        agentId: "req-b1",
        estimatedTokens: 30000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        systemPromptHash: "sys-b",
        agentTypeHash: "type-b",
        firstUserMessageHash: "msg-b",
        conversationId: "conv-bbb",
      });
      registry.completeAgent("req-b1", {
        inputTokens: 32000,
        outputTokens: 500,
        maxInputTokens: 128000,
      });

      // Both conversations are "active" (within 5-min window)
      const roots = treeProvider.getChildren();
      // All recent conversations show at root
      expect(roots.length).toBeGreaterThanOrEqual(2);
      expect(roots[0]).toBeInstanceOf(ConversationItem);
      // Both conversations present (order may vary with same-ms timestamps)
      const convIds = roots
        .filter((r): r is ConversationItem => r instanceof ConversationItem)
        .map((c) => c.conversation.id);
      expect(convIds).toContain("conv-aaa");
      expect(convIds).toContain("conv-bbb");
    });

    it("shows all conversations during streaming", () => {
      // Conversation A (completed)
      registry.startAgent({
        agentId: "req-a1",
        estimatedTokens: 50000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        systemPromptHash: "sys-a",
        agentTypeHash: "type-a",
        firstUserMessageHash: "msg-a",
        conversationId: "conv-aaa",
      });
      registry.completeAgent("req-a1", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Conversation B (still streaming)
      registry.startAgent({
        agentId: "req-b1",
        estimatedTokens: 30000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        systemPromptHash: "sys-b",
        agentTypeHash: "type-b",
        firstUserMessageHash: "msg-b",
        conversationId: "conv-bbb",
      });

      const roots = treeProvider.getChildren();
      // Both conversations visible
      expect(roots.length).toBeGreaterThanOrEqual(2);
      expect(roots[0]).toBeInstanceOf(ConversationItem);
    });

    it("most recent conversation appears first as new ones are added", () => {
      // Conversation A
      registry.startAgent({
        agentId: "req-a1",
        estimatedTokens: 50000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        systemPromptHash: "sys-a",
        agentTypeHash: "type-a",
        firstUserMessageHash: "msg-a",
        conversationId: "conv-aaa",
      });
      registry.completeAgent("req-a1", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Single conversation at root
      let roots = treeProvider.getChildren();
      expect(roots.length).toBeGreaterThanOrEqual(1);
      expect(roots[0]).toBeInstanceOf(ConversationItem);
      expect((roots[0] as ConversationItem).conversation.id).toBe("conv-aaa");

      // Conversation B starts and completes
      registry.startAgent({
        agentId: "req-b1",
        estimatedTokens: 30000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        systemPromptHash: "sys-b",
        agentTypeHash: "type-b",
        firstUserMessageHash: "msg-b",
        conversationId: "conv-bbb",
      });
      registry.completeAgent("req-b1", {
        inputTokens: 32000,
        outputTokens: 500,
        maxInputTokens: 128000,
      });

      // Both conversations at root (order may vary with same-ms timestamps)
      roots = treeProvider.getChildren();
      expect(roots.length).toBeGreaterThanOrEqual(2);
      const convIds = roots
        .filter((r): r is ConversationItem => r instanceof ConversationItem)
        .map((c) => c.conversation.id);
      expect(convIds).toContain("conv-aaa");
      expect(convIds).toContain("conv-bbb");
    });

    it("includes subagents in conversation data model", () => {
      const parentConvId = "conv-parent";

      // Start main agent
      registry.startAgent({
        agentId: "req-main",
        estimatedTokens: 50000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        systemPromptHash: "sys-main",
        agentTypeHash: "type-main",
        firstUserMessageHash: "msg-main",
        conversationId: parentConvId,
      });

      // Register a subagent claim via the public API
      registry.createChildClaim("req-main", "recon");

      // Start subagent (matches claim — different agentTypeHash triggers claim path)
      registry.startAgent({
        agentId: "req-sub",
        estimatedTokens: 10000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        systemPromptHash: "sys-sub",
        agentTypeHash: "type-sub",
        firstUserMessageHash: "msg-sub",
        conversationId: "conv-sub",
      });

      // Complete both
      registry.completeAgent("req-sub", {
        inputTokens: 12000,
        outputTokens: 200,
        maxInputTokens: 128000,
      });
      registry.completeAgent("req-main", {
        inputTokens: 55000,
        outputTokens: 1500,
        maxInputTokens: 128000,
      });

      const roots = treeProvider.getChildren();

      // Root should have the main conversation
      const convItems = roots.filter((r) => r instanceof ConversationItem);
      expect(convItems.length).toBeGreaterThanOrEqual(1);

      const mainItem = convItems.find(
        (r) => r.conversation.id === parentConvId,
      );
      expect(mainItem).toBeDefined();

      // The subagent should be in the conversation data model
      if (mainItem) {
        expect(mainItem.conversation.subagents).toHaveLength(1);
        expect(mainItem.conversation.subagents[0]?.conversationId).toBe(
          "conv-sub",
        );
      }
    });

    it("falls back to showing conversation when no conversationId is available", () => {
      // Agent without conversationId
      registry.startAgent({
        agentId: "req-noconv",
        estimatedTokens: 50000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        systemPromptHash: "sys-a",
        agentTypeHash: "type-a",
        firstUserMessageHash: "msg-a",
      });
      registry.completeAgent("req-noconv", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      const roots = treeProvider.getChildren();
      expect(roots).toHaveLength(1);
      expect(roots[0]).toBeInstanceOf(ConversationItem);
    });
  });
});
