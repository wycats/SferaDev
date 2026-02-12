/**
 * Integration tests for the conversationId-based identity pipeline.
 *
 * Exercises TokenStatusBar + AgentTreeDataProvider together, verifying
 * that conversationId-based identity produces correct:
 * - Multi-turn resume behavior (same conversationId → same agent)
 * - Token accumulation across turns
 * - Parent-child hierarchy with claim registry
 * - AgentTreeDataProvider rendering (root vs children, tree refresh events)
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
      return { dispose: () => {} };
    };
    fire(data: T) {
      this.listeners.forEach((l) => l(data));
    }
    dispose() {}
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
}));

import { AgentTreeDataProvider, AgentTreeItem } from "./agent-tree";
import { TokenStatusBar } from "./status-bar";

describe("conversationId identity pipeline (integration)", () => {
  let statusBar: TokenStatusBar;
  let treeProvider: AgentTreeDataProvider;
  let treeChangeCount: number;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStatusBarItem.text = "";
    mockStatusBarItem.tooltip = "";
    mockStatusBarItem.backgroundColor = undefined;
    statusBar = new TokenStatusBar();
    treeProvider = new AgentTreeDataProvider();
    treeProvider.setStatusBar(statusBar);
    treeChangeCount = 0;
    treeProvider.onDidChangeTreeData(() => {
      treeChangeCount++;
    });
  });

  describe("multi-turn conversation tracking", () => {
    it("resumes agent by conversationId on subsequent turns", () => {
      const conversationId = "conv-abc-123";

      // Turn 1: new agent
      const turn1Id = statusBar.startAgent(
        "req-turn1",
        50000,
        128000,
        "anthropic:claude-sonnet-4",
        "sys-hash",
        "type-hash",
        "user-msg-hash",
        undefined,
        conversationId,
      );
      statusBar.completeAgent("req-turn1", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Turn 2: same conversationId → should resume, not create new
      const turn2Id = statusBar.startAgent(
        "req-turn2",
        55000,
        128000,
        "anthropic:claude-sonnet-4",
        "sys-hash",
        "type-hash",
        "user-msg-hash",
        undefined,
        conversationId,
      );

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
      statusBar.startAgent(
        "req-1",
        50000,
        128000,
        "anthropic:claude-sonnet-4",
        undefined,
        undefined,
        undefined,
        undefined,
        conversationId,
      );
      statusBar.completeAgent("req-1", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Turn 2: resumed by conversationId
      statusBar.startAgent(
        "req-2",
        55000,
        128000,
        "anthropic:claude-sonnet-4",
        undefined,
        undefined,
        undefined,
        undefined,
        conversationId,
      );
      statusBar.completeAgent("req-2", {
        inputTokens: 58000,
        outputTokens: 1500,
        maxInputTokens: 128000,
      });

      const agents = statusBar.getAgents();
      expect(agents).toHaveLength(1);
      const agent = agents[0]!;

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
      statusBar.startAgent(
        "req-a",
        50000,
        128000,
        "anthropic:claude-sonnet-4",
        undefined,
        "type-a",
        undefined,
        undefined,
        "conv-A",
      );
      statusBar.completeAgent("req-a", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Create claim so second agent isn't treated as main replacement
      statusBar.createChildClaim("req-a", "other");

      statusBar.startAgent(
        "req-b",
        30000,
        128000,
        "anthropic:claude-sonnet-4",
        undefined,
        "type-b",
        undefined,
        undefined,
        "conv-B",
      );

      const agents = statusBar.getAgents();
      expect(agents).toHaveLength(2);
    });
  });

  describe("multi-agent hierarchy", () => {
    it("subagent links to parent via claim and renders in tree", () => {
      const mainConvId = "conv-main";
      const subConvId = "conv-sub";

      // Main agent starts and completes
      statusBar.startAgent(
        "main-req",
        50000,
        128000,
        "anthropic:claude-sonnet-4",
        "main-sys",
        "main-type",
        undefined,
        undefined,
        mainConvId,
      );
      statusBar.completeAgent("main-req", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Parent creates a claim for expected child
      statusBar.createChildClaim("main-req", "recon");

      // Subagent starts with different type hash → matches claim
      statusBar.startAgent(
        "sub-req",
        8000,
        128000,
        "recon-model",
        "sub-sys",
        "sub-type",
        undefined,
        undefined,
        subConvId,
      );

      // Verify agent hierarchy
      const agents = statusBar.getAgents();
      expect(agents).toHaveLength(2);

      const mainAgent = agents.find((a) => a.id === "main-req");
      const subAgent = agents.find((a) => a.id === "sub-req");
      expect(mainAgent?.isMain).toBe(true);
      expect(subAgent?.isMain).toBe(false);
      expect(subAgent?.parentConversationHash).toBe(mainConvId);

      // Verify tree structure: root should only show main agent
      const roots = treeProvider.getChildren(undefined);
      expect(roots).toHaveLength(1);
      expect(roots[0]).toBeInstanceOf(AgentTreeItem);
      const rootItem = roots[0] as AgentTreeItem;
      expect(rootItem.agent.id).toBe("main-req");
      // Main agent should be expandable (has children)
      expect(rootItem.collapsibleState).toBe(2); // Expanded

      // Children of main agent should include the subagent
      const children = treeProvider.getChildren(rootItem);
      expect(children).toHaveLength(1);
      expect(children[0]).toBeInstanceOf(AgentTreeItem);
      const childItem = children[0] as AgentTreeItem;
      expect(childItem.agent.id).toBe("sub-req");
      expect(childItem.agent.name).toBe("recon");
    });

    it("multiple subagents appear as siblings under parent", () => {
      const mainConvId = "conv-main-multi";

      statusBar.startAgent(
        "main",
        50000,
        128000,
        "anthropic:claude-sonnet-4",
        undefined,
        "main-type",
        undefined,
        undefined,
        mainConvId,
      );
      statusBar.completeAgent("main", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Create claims for two subagents
      statusBar.createChildClaim("main", "recon");
      statusBar.createChildClaim("main", "execute");

      // First subagent
      statusBar.startAgent(
        "sub-recon",
        8000,
        128000,
        "recon-model",
        undefined,
        "recon-type",
        undefined,
        undefined,
        "conv-sub-recon",
      );
      statusBar.completeAgent("sub-recon", {
        inputTokens: 8500,
        outputTokens: 500,
        maxInputTokens: 128000,
      });

      // Second subagent
      statusBar.startAgent(
        "sub-exec",
        12000,
        128000,
        "exec-model",
        undefined,
        "exec-type",
        undefined,
        undefined,
        "conv-sub-exec",
      );

      // Tree root should be main only
      const roots = treeProvider.getChildren(undefined);
      expect(roots).toHaveLength(1);

      // Main should have 2 children
      const children = treeProvider.getChildren(roots[0]!);
      expect(children).toHaveLength(2);

      const childNames = children.map((c) => (c as AgentTreeItem).agent.name);
      expect(childNames).toContain("recon");
      expect(childNames).toContain("execute");
    });
  });

  describe("tree refresh events", () => {
    it("fires onDidChangeTreeData on startAgent", () => {
      const countBefore = treeChangeCount;
      statusBar.startAgent("agent-1", 50000, 128000);
      expect(treeChangeCount).toBeGreaterThan(countBefore);
    });

    it("fires onDidChangeTreeData on completeAgent", () => {
      statusBar.startAgent("agent-1", 50000, 128000);
      const countBefore = treeChangeCount;
      statusBar.completeAgent("agent-1", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });
      expect(treeChangeCount).toBeGreaterThan(countBefore);
    });

    it("fires onDidChangeTreeData on resume", () => {
      const convId = "conv-refresh";
      statusBar.startAgent(
        "req-1",
        50000,
        128000,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        convId,
      );
      statusBar.completeAgent("req-1", {
        inputTokens: 52000,
        outputTokens: 1000,
      });

      const countBefore = treeChangeCount;
      statusBar.startAgent(
        "req-2",
        55000,
        128000,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        convId,
      );
      expect(treeChangeCount).toBeGreaterThan(countBefore);
    });
  });

  describe("context percentage correctness", () => {
    it("never shows >100% for a single agent", () => {
      const convId = "conv-pct";

      statusBar.startAgent(
        "req-1",
        50000,
        128000,
        "anthropic:claude-sonnet-4",
        undefined,
        undefined,
        undefined,
        undefined,
        convId,
      );
      statusBar.completeAgent("req-1", {
        inputTokens: 100000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      const agents = statusBar.getAgents();
      const agent = agents[0]!;
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
      statusBar.startAgent(
        "main-req",
        50000,
        128000,
        "anthropic:claude-sonnet-4",
        undefined,
        "main-type",
        undefined,
        undefined,
        mainConvId,
      );
      statusBar.completeAgent("main-req", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Claim + subagent with very different token count
      statusBar.createChildClaim("main-req", "recon");
      statusBar.startAgent(
        "sub-req",
        8000,
        128000,
        "recon",
        undefined,
        "sub-type",
      );
      statusBar.completeAgent("sub-req", {
        inputTokens: 8500,
        outputTokens: 500,
        maxInputTokens: 128000,
      });

      // Main agent should still show 52k/128k, not inflated by subagent
      const agents = statusBar.getAgents();
      const mainAgent = agents.find((a) => a.id === "main-req")!;
      expect(mainAgent.inputTokens).toBe(52000);
      expect(mainAgent.maxInputTokens).toBe(128000);

      const mainPct = Math.round(
        (mainAgent.inputTokens / mainAgent.maxInputTokens!) * 100,
      );
      expect(mainPct).toBe(41); // 52000/128000 = 40.6%
      expect(mainPct).toBeLessThanOrEqual(100);

      // Subagent should have its own independent percentage
      const subAgent = agents.find((a) => a.id === "sub-req")!;
      expect(subAgent.inputTokens).toBe(8500);
      const subPct = Math.round(
        (subAgent.inputTokens / subAgent.maxInputTokens!) * 100,
      );
      expect(subPct).toBe(7); // 8500/128000 = 6.6%
    });

    it("multi-turn percentage uses latest actual tokens (reflects summarization reductions)", () => {
      const convId = "conv-multiturn-pct";

      // Turn 1: high input
      statusBar.startAgent(
        "req-1",
        100000,
        128000,
        "anthropic:claude-sonnet-4",
        undefined,
        undefined,
        undefined,
        undefined,
        convId,
      );
      statusBar.completeAgent("req-1", {
        inputTokens: 100000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Turn 2: lower input (e.g., after summarization/compaction)
      statusBar.startAgent(
        "req-2",
        60000,
        128000,
        "anthropic:claude-sonnet-4",
        undefined,
        undefined,
        undefined,
        undefined,
        convId,
      );
      statusBar.completeAgent("req-2", {
        inputTokens: 60000,
        outputTokens: 800,
        maxInputTokens: 128000,
      });

      const agent = statusBar.getAgents()[0]!;
      expect(agent.turnCount).toBe(2);
      // lastActualInputTokens should be 60000 (latest turn), not 100000 (peak)
      // After summarization, context shrinks and the display should reflect that
      expect(agent.lastActualInputTokens).toBe(60000);

      // Tree description should use latest actual for percentage
      const roots = treeProvider.getChildren(undefined);
      const treeItem = roots[0] as AgentTreeItem;
      // Description should contain percentage based on 60k/128k = 47%
      expect(treeItem.description).toContain("47%");
    });

    it("summarization boundary: tokens drop sharply and display reflects reduction", () => {
      const convId = "conv-summarization-boundary";

      // Turn 1: near context limit (120k/128k = 94%)
      statusBar.startAgent(
        "req-pre-summ",
        120000,
        128000,
        "anthropic:claude-sonnet-4",
        undefined,
        undefined,
        undefined,
        undefined,
        convId,
      );
      statusBar.completeAgent("req-pre-summ", {
        inputTokens: 120000,
        outputTokens: 2000,
        maxInputTokens: 128000,
      });

      // Verify pre-summarization state
      let agent = statusBar.getAgents()[0]!;
      expect(agent.lastActualInputTokens).toBe(120000);

      // Turn 2: VS Code summarizes → context drops to 30k (77% reduction)
      statusBar.startAgent(
        "req-post-summ",
        30000,
        128000,
        "anthropic:claude-sonnet-4",
        undefined,
        undefined,
        undefined,
        undefined,
        convId,
      );
      statusBar.completeAgent("req-post-summ", {
        inputTokens: 30000,
        outputTokens: 500,
        maxInputTokens: 128000,
      });

      agent = statusBar.getAgents()[0]!;
      expect(agent.turnCount).toBe(2);
      // After summarization, display should show 30k (not stuck at 120k)
      expect(agent.lastActualInputTokens).toBe(30000);
      // Percentage should be 30k/128k = 23%, not 94%
      const pct = Math.round(
        (agent.lastActualInputTokens / agent.maxInputTokens!) * 100,
      );
      expect(pct).toBe(23);

      // Tree should also reflect the reduction
      const roots = treeProvider.getChildren(undefined);
      const treeItem = roots[0] as AgentTreeItem;
      expect(treeItem.description).toContain("23%");
    });

    it("streaming delta uses latest actual as base, not stale peak", () => {
      const convId = "conv-delta-base";

      // Turn 1: 100k input
      statusBar.startAgent(
        "req-t1",
        100000,
        128000,
        "anthropic:claude-sonnet-4",
        undefined,
        undefined,
        undefined,
        undefined,
        convId,
      );
      statusBar.completeAgent("req-t1", {
        inputTokens: 100000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Turn 2: after summarization, context drops to 40k
      statusBar.startAgent(
        "req-t2",
        40000,
        128000,
        "anthropic:claude-sonnet-4",
        undefined,
        undefined,
        undefined,
        undefined,
        convId,
      );
      statusBar.completeAgent("req-t2", {
        inputTokens: 40000,
        outputTokens: 800,
        maxInputTokens: 128000,
      });

      // Turn 3: streaming with delta — base should be 40k (latest), not 100k (peak)
      statusBar.startAgent(
        "req-t3",
        45000, // full estimate
        128000,
        "anthropic:claude-sonnet-4",
        undefined,
        undefined,
        undefined,
        undefined,
        convId,
      );

      const agent = statusBar.getAgents()[0]!;
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
      statusBar.startAgent(
        "req-no-conv",
        50000,
        128000,
        "anthropic:claude-sonnet-4",
      );
      statusBar.completeAgent("req-no-conv", {
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

    it("clearAgents resets tree to empty", () => {
      statusBar.startAgent(
        "req-1",
        50000,
        128000,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "conv-1",
      );

      statusBar.clearAgents();

      const agents = statusBar.getAgents();
      expect(agents).toHaveLength(0);

      const roots = treeProvider.getChildren(undefined);
      expect(roots).toHaveLength(0);
    });

    it("resumed agent maintains isMain across turns", () => {
      const convId = "conv-main-persist";

      statusBar.startAgent(
        "req-1",
        50000,
        128000,
        "anthropic:claude-sonnet-4",
        "sys",
        "type",
        undefined,
        undefined,
        convId,
      );
      statusBar.completeAgent("req-1", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Create a claim (shouldn't affect main agent resume)
      statusBar.createChildClaim("req-1", "recon");

      // Turn 2: resume with same conversationId
      statusBar.startAgent(
        "req-2",
        55000,
        128000,
        "anthropic:claude-sonnet-4",
        "sys",
        "type",
        undefined,
        undefined,
        convId,
      );
      statusBar.completeAgent("req-2", {
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
      statusBar.startAgent(
        "recon-req",
        8000,
        128000,
        "recon",
        "diff-sys",
        "diff-type",
        undefined,
        undefined,
        "conv-recon",
      );

      const agentsAfter = statusBar.getAgents();
      const recon = agentsAfter.find((a) => a.id === "recon-req");
      expect(recon?.isMain).toBe(false);
      expect(recon?.name).toBe("recon");
    });
  });

  describe("sidebar conversation filtering (fix-sidebar-composite)", () => {
    it("shows only the most recent conversation when idle", () => {
      // Conversation A
      statusBar.startAgent(
        "req-a1",
        50000,
        128000,
        "anthropic:claude-sonnet-4",
        "sys-a",
        "type-a",
        "msg-a",
        undefined,
        "conv-aaa",
      );
      statusBar.completeAgent("req-a1", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Conversation B (becomes the most recent)
      statusBar.startAgent(
        "req-b1",
        30000,
        128000,
        "anthropic:claude-sonnet-4",
        "sys-b",
        "type-b",
        "msg-b",
        undefined,
        "conv-bbb",
      );
      statusBar.completeAgent("req-b1", {
        inputTokens: 32000,
        outputTokens: 500,
        maxInputTokens: 128000,
      });

      // Now idle — sidebar should show only conv-bbb
      expect(statusBar.getActiveAgentId()).toBeNull();
      expect(statusBar.getLastActiveConversationId()).toBe("conv-bbb");

      const roots = treeProvider.getChildren();
      expect(roots).toHaveLength(1);
      expect(roots[0]).toBeInstanceOf(AgentTreeItem);
      expect((roots[0] as AgentTreeItem).agent.conversationId).toBe("conv-bbb");
    });

    it("shows all agents during streaming (not filtered)", () => {
      // Conversation A (completed)
      statusBar.startAgent(
        "req-a1",
        50000,
        128000,
        "anthropic:claude-sonnet-4",
        "sys-a",
        "type-a",
        "msg-a",
        undefined,
        "conv-aaa",
      );
      statusBar.completeAgent("req-a1", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Conversation B (still streaming)
      statusBar.startAgent(
        "req-b1",
        30000,
        128000,
        "anthropic:claude-sonnet-4",
        "sys-b",
        "type-b",
        "msg-b",
        undefined,
        "conv-bbb",
      );

      // During streaming — sidebar should show all agents
      expect(statusBar.getActiveAgentId()).not.toBeNull();

      const roots = treeProvider.getChildren();
      // Both conversations visible during streaming
      expect(roots.length).toBeGreaterThanOrEqual(2);
    });

    it("updates filtered view when conversation switches", () => {
      // Conversation A
      statusBar.startAgent(
        "req-a1",
        50000,
        128000,
        "anthropic:claude-sonnet-4",
        "sys-a",
        "type-a",
        "msg-a",
        undefined,
        "conv-aaa",
      );
      statusBar.completeAgent("req-a1", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Idle — should show conv-aaa
      let roots = treeProvider.getChildren();
      expect(roots).toHaveLength(1);
      expect((roots[0] as AgentTreeItem).agent.conversationId).toBe("conv-aaa");

      // Conversation B starts and completes
      statusBar.startAgent(
        "req-b1",
        30000,
        128000,
        "anthropic:claude-sonnet-4",
        "sys-b",
        "type-b",
        "msg-b",
        undefined,
        "conv-bbb",
      );
      statusBar.completeAgent("req-b1", {
        inputTokens: 32000,
        outputTokens: 500,
        maxInputTokens: 128000,
      });

      // Idle again — should now show conv-bbb (not conv-aaa)
      roots = treeProvider.getChildren();
      expect(roots).toHaveLength(1);
      expect((roots[0] as AgentTreeItem).agent.conversationId).toBe("conv-bbb");
    });

    it("includes subagents of the active conversation when idle", () => {
      const parentConvId = "conv-parent";

      // Start main agent
      statusBar.startAgent(
        "req-main",
        50000,
        128000,
        "anthropic:claude-sonnet-4",
        "sys-main",
        "type-main",
        "msg-main",
        undefined,
        parentConvId,
      );

      // Register a subagent claim via the public API
      statusBar.createChildClaim("req-main", "recon");

      // Start subagent (matches claim — different agentTypeHash triggers claim path)
      statusBar.startAgent(
        "req-sub",
        10000,
        128000,
        "anthropic:claude-sonnet-4",
        "sys-sub",
        "type-sub",
        "msg-sub",
        undefined,
        "conv-sub",
      );

      // Complete both
      statusBar.completeAgent("req-sub", {
        inputTokens: 12000,
        outputTokens: 200,
        maxInputTokens: 128000,
      });
      statusBar.completeAgent("req-main", {
        inputTokens: 55000,
        outputTokens: 1500,
        maxInputTokens: 128000,
      });

      // Idle — should show main agent with subagent as child
      expect(statusBar.getActiveAgentId()).toBeNull();
      expect(statusBar.getLastActiveConversationId()).toBe(parentConvId);

      const roots = treeProvider.getChildren();

      // Root should have the main agent
      const mainItems = roots.filter(
        (r) => r instanceof AgentTreeItem,
      ) as AgentTreeItem[];
      expect(mainItems.length).toBeGreaterThanOrEqual(1);

      const mainItem = mainItems.find(
        (r) => r.agent.conversationId === parentConvId,
      );
      expect(mainItem).toBeDefined();

      // The subagent should be accessible as a child
      if (mainItem) {
        const children = treeProvider.getChildren(mainItem);
        const subItems = children.filter(
          (c) => c instanceof AgentTreeItem,
        ) as AgentTreeItem[];
        expect(subItems).toHaveLength(1);
        expect(subItems[0]?.agent.id).toBe("req-sub");
      }
    });

    it("falls back to showing all agents when no conversationId is available", () => {
      // Agent without conversationId
      statusBar.startAgent(
        "req-noconv",
        50000,
        128000,
        "anthropic:claude-sonnet-4",
        "sys-a",
        "type-a",
        "msg-a",
      );
      statusBar.completeAgent("req-noconv", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Idle, no lastActiveConversationId → show all
      expect(statusBar.getLastActiveConversationId()).toBeNull();
      const roots = treeProvider.getChildren();
      expect(roots).toHaveLength(1);
    });
  });
});
