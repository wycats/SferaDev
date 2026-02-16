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
  EventEmitter: class EventEmitter<T> {
    private listeners: ((e: T) => void)[] = [];
    event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => { /* noop */ } };
    };
    fire(data: T) {
      this.listeners.forEach((l) => { l(data); });
    }
    dispose() { /* noop */ }
  },
}));

// Import after mocking
import { AgentRegistryImpl } from "./agent";
import { TokenStatusBar } from "./status-bar";

describe("TokenStatusBar", () => {
  let statusBar: TokenStatusBar;
  let registry: AgentRegistryImpl;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStatusBarItem.text = "";
    mockStatusBarItem.tooltip = "";
    mockStatusBarItem.backgroundColor = undefined;
    registry = new AgentRegistryImpl();
    statusBar = new TokenStatusBar(registry);
  });

  describe("startAgent", () => {
    it("shows streaming indicator when agent starts", () => {
      registry.startAgent({
        agentId: "agent-1",
        estimatedTokens: 50000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
      });

      expect(mockStatusBarItem.text).toBe("$(loading~spin) 50.0k/128.0k 39%");
      expect(mockStatusBarItem.show).toHaveBeenCalled();
    });

    it("shows streaming without token info when no estimates", () => {
      registry.startAgent({ agentId: "agent-1" });

      expect(mockStatusBarItem.text).toBe("$(loading~spin) streaming...");
      expect(mockStatusBarItem.show).toHaveBeenCalled();
    });

    it("shows summarizing indicator when summarization streaming", () => {
      registry.startAgent({
        agentId: "agent-1",
        isSummarization: true,
      });

      expect(mockStatusBarItem.text).toBe("$(sync~spin) summarizing...");
      expect(mockStatusBarItem.show).toHaveBeenCalled();
    });

    it("extracts display name from model ID", () => {
      registry.startAgent({
        agentId: "agent-1",
        estimatedTokens: 50000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
      });
      registry.completeAgent("agent-1", {
        inputTokens: 50000,
        outputTokens: 1000,
        maxInputTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
      });
    });
  });

  describe("completeAgent", () => {
    it("shows usage after agent completes", () => {
      registry.startAgent({
        agentId: "agent-1",
        estimatedTokens: 50000,
        maxTokens: 128000,
      });
      registry.completeAgent("agent-1", {
        inputTokens: 52000,
        outputTokens: 1500,
        maxInputTokens: 128000,
      });

      expect(mockStatusBarItem.text).toBe(
        "$(debug-breakpoint-function) 52.0k/128.0k 41%",
      );
      expect(mockStatusBarItem.show).toHaveBeenCalled();
    });

    it("stores usage for later retrieval", () => {
      registry.startAgent({ agentId: "agent-1" });
      const usage = {
        inputTokens: 5000,
        outputTokens: 1000,
        maxInputTokens: 128000,
        modelId: "openai:gpt-4o",
      };
      registry.completeAgent("agent-1", usage);

      const lastUsage = statusBar.getLastUsage();
      expect(lastUsage?.inputTokens).toBe(5000);
      expect(lastUsage?.outputTokens).toBe(1000);
    });

    it("shows compaction info with freed tokens", () => {
      registry.startAgent({ agentId: "agent-1" });
      registry.completeAgent("agent-1", {
        inputTokens: 37100,
        outputTokens: 1200,
        maxInputTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        contextManagement: {
          appliedEdits: [
            {
              type: "clear_tool_uses_20250919",
              clearedInputTokens: 15200,
              clearedToolUses: 8,
            },
          ],
        },
      });

      expect(mockStatusBarItem.text).toBe(
        "$(debug-breakpoint-function) 37.1k/128.0k 29% ↓15.2k",
      );
    });

    it("clears summarization flag after completion", () => {
      registry.startAgent({
        agentId: "agent-1",
        estimatedTokens: 50000,
        maxTokens: 128000,
        isSummarization: true,
      });
      registry.completeAgent("agent-1", {
        inputTokens: 52000,
        outputTokens: 1500,
        maxInputTokens: 128000,
      });

      const agent = statusBar.getAgents()[0];
      expect(agent?.isSummarization).toBeUndefined();
    });
  });

  describe("errorAgent", () => {
    it("marks agent as error", () => {
      registry.startAgent({
        agentId: "agent-1",
        estimatedTokens: 50000,
        maxTokens: 128000,
      });
      registry.errorAgent("agent-1");

      const agents = statusBar.getAgents();
      expect(agents).toHaveLength(1);
      const first = agents[0];
      expect(first).toBeDefined();
      if (!first) {
        throw new Error("Expected agent to be defined");
      }
      expect(first.status).toBe("error");
    });
  });

  describe("showError", () => {
    it("shows error state", () => {
      statusBar.showError("Token limit exceeded: 150000 tokens");

      expect(mockStatusBarItem.text).toBe("$(error) Token limit exceeded");
      expect(mockStatusBarItem.backgroundColor).toBeDefined();
      expect(mockStatusBarItem.show).toHaveBeenCalled();
    });
  });

  describe("warning thresholds", () => {
    it("shows warning background at 75%+ usage", () => {
      registry.startAgent({ agentId: "agent-1" });
      registry.completeAgent("agent-1", {
        inputTokens: 100000,
        outputTokens: 500,
        maxInputTokens: 128000,
      });

      expect(mockStatusBarItem.backgroundColor).toBeDefined();
    });

    it("shows warning background at 90%+ usage", () => {
      registry.startAgent({ agentId: "agent-1" });
      registry.completeAgent("agent-1", {
        inputTokens: 120000,
        outputTokens: 500,
        maxInputTokens: 128000,
      });

      expect(mockStatusBarItem.backgroundColor).toBeDefined();
    });
  });

  describe("hide", () => {
    it("hides the status bar", () => {
      statusBar.hide();

      expect(mockStatusBarItem.hide).toHaveBeenCalled();
    });
  });

  describe("formatTokenCount", () => {
    it("formats small numbers as-is", () => {
      registry.startAgent({ agentId: "agent-1" });
      registry.completeAgent("agent-1", {
        inputTokens: 500,
        outputTokens: 100,
      });
      expect(mockStatusBarItem.text).toContain("500");
    });

    it("formats thousands with k suffix", () => {
      registry.startAgent({ agentId: "agent-1" });
      registry.completeAgent("agent-1", {
        inputTokens: 5000,
        outputTokens: 100,
      });
      expect(mockStatusBarItem.text).toContain("5.0k");
    });

    it("formats millions with M suffix", () => {
      registry.startAgent({ agentId: "agent-1" });
      registry.completeAgent("agent-1", {
        inputTokens: 1500000,
        outputTokens: 100,
      });
      expect(mockStatusBarItem.text).toContain("1.5M");
    });
  });

  describe("dispose", () => {
    it("disposes the status bar item", () => {
      statusBar.dispose();

      expect(mockStatusBarItem.dispose).toHaveBeenCalled();
    });
  });

  describe("agent lifecycle and aging", () => {
    it("dims agent after 2 newer completions", () => {
      // First agent completes (main agent)
      registry.startAgent({
        agentId: "agent-1",
        estimatedTokens: 50000,
        maxTokens: 128000,
        systemPromptHash: "main-hash",
        agentTypeHash: "type-1",
      });
      registry.completeAgent("agent-1", {
        inputTokens: 50000,
        outputTokens: 1000,
      });

      // Create claims for subagents (required for proper subagent detection)
      registry.createChildClaim("agent-1", "sub2");
      registry.createChildClaim("agent-1", "sub3");
      registry.createChildClaim("agent-1", "sub4");

      // Three subagents complete - first subagent should be dimmed after 2 newer completions
      registry.startAgent({
        agentId: "agent-2",
        estimatedTokens: 30000,
        maxTokens: 128000,
        systemPromptHash: "sub-hash",
        agentTypeHash: "type-2",
      });
      registry.completeAgent("agent-2", {
        inputTokens: 30000,
        outputTokens: 500,
      });

      registry.startAgent({
        agentId: "agent-3",
        estimatedTokens: 20000,
        maxTokens: 128000,
        systemPromptHash: "sub-hash",
        agentTypeHash: "type-3",
      });
      registry.completeAgent("agent-3", {
        inputTokens: 20000,
        outputTokens: 300,
      });

      registry.startAgent({
        agentId: "agent-4",
        estimatedTokens: 15000,
        maxTokens: 128000,
        systemPromptHash: "sub-hash",
        agentTypeHash: "type-4",
      });
      registry.completeAgent("agent-4", {
        inputTokens: 15000,
        outputTokens: 200,
      });

      const agents = statusBar.getAgents();
      // Main agent should NOT be dimmed (it's always kept)
      const agent1 = agents.find((a) => a.id === "agent-1");
      expect(agent1?.dimmed).toBe(false);
      // First subagent should be dimmed after 2 newer completions
      const agent2 = agents.find((a) => a.id === "agent-2");
      expect(agent2?.dimmed).toBe(true);
    });

    it("removes agent after 5 newer completions", () => {
      // First agent completes (main agent)
      registry.startAgent({
        agentId: "agent-1",
        estimatedTokens: 50000,
        maxTokens: 128000,
        systemPromptHash: "main-hash",
        agentTypeHash: "type-1",
      });
      registry.completeAgent("agent-1", {
        inputTokens: 50000,
        outputTokens: 1000,
      });

      // Create claims for all subagents (required for proper subagent detection)
      for (let i = 2; i <= 7; i++) {
        registry.createChildClaim("agent-1", `sub${i.toString()}`);
      }

      // Six subagents complete - first subagent should be removed after 5 newer completions
      for (let i = 2; i <= 7; i++) {
        registry.startAgent({
          agentId: `agent-${i.toString()}`,
          estimatedTokens: 10000,
          maxTokens: 128000,
          systemPromptHash: "sub-hash",
          agentTypeHash: `type-${i.toString()}`,
        });
        registry.completeAgent(`agent-${i.toString()}`, {
          inputTokens: 10000,
          outputTokens: 100,
        });
      }

      const agents = statusBar.getAgents();
      // Main agent should NOT be removed (it's always kept)
      const agent1 = agents.find((a) => a.id === "agent-1");
      expect(agent1).toBeDefined();
      // First subagent should be removed after 5 newer completions
      const agent2 = agents.find((a) => a.id === "agent-2");
      expect(agent2).toBeUndefined();
    });

    it("clears all agents", () => {
      registry.startAgent({
        agentId: "agent-1",
        estimatedTokens: 50000,
        maxTokens: 128000,
      });
      registry.startAgent({
        agentId: "agent-2",
        estimatedTokens: 30000,
        maxTokens: 128000,
      });

      registry.clearAgents();

      expect(statusBar.getAgents()).toHaveLength(0);
    });
  });

  describe("multi-agent display", () => {
    it("shows subagent alongside main agent when active", () => {
      // Main agent starts and completes (with maxInputTokens for consistent format)
      // Subagent detection uses claim registry + agentTypeHash differences
      const mainHash = "main-system-prompt-hash-abc123"; // diagnostics only
      const subagentHash = "subagent-system-prompt-hash-xyz789"; // diagnostics only
      const mainTypeHash = "main-type-hash";
      const subTypeHash = "sub-type-hash";

      registry.startAgent({
        agentId: "main-agent",
        estimatedTokens: 50000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        systemPromptHash: mainHash,
        agentTypeHash: mainTypeHash,
      });
      registry.completeAgent("main-agent", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Create a claim for the subagent (required for proper subagent detection)
      registry.createChildClaim("main-agent", "recon");

      // Subagent starts with different agentTypeHash and matching claim
      registry.startAgent({
        agentId: "recon-agent",
        estimatedTokens: 8000,
        maxTokens: 128000,
        modelId: "recon",
        systemPromptHash: subagentHash,
        agentTypeHash: subTypeHash,
      });

      expect(mockStatusBarItem.text).toContain("52.0k/128.0k 41%");
    });

    it("detects subagent via claim even with identical hashes (regression: 104% bug)", () => {
      // This is a regression test for Issue #4: Subagent detection bypass causes 104% token display
      // The bug occurred when a subagent had the SAME agentTypeHash as the main agent,
      // causing claim matching to be skipped entirely.
      const sameHash = "identical-hash-for-both"; // diagnostics only
      const sameTypeHash = "identical-type-hash";

      // Main agent starts with specific hashes
      registry.startAgent({
        agentId: "main-agent",
        estimatedTokens: 50000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        systemPromptHash: sameHash,
        agentTypeHash: sameTypeHash,
      });
      registry.completeAgent("main-agent", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Create a claim for the subagent
      registry.createChildClaim("main-agent", "execute");

      // Subagent starts with IDENTICAL hashes (this was the bug trigger)
      // The claim should still be matched because we check claims FIRST
      registry.startAgent({
        agentId: "sub-agent",
        estimatedTokens: 8000,
        maxTokens: 128000,
        modelId: "execute",
        systemPromptHash: sameHash,
        agentTypeHash: sameTypeHash,
      });

      const agents = statusBar.getAgents();
      const mainAgent = agents.find((a) => a.id === "main-agent");
      const subAgent = agents.find((a) => a.id === "sub-agent");

      // Both agents should exist
      expect(mainAgent).toBeDefined();
      expect(subAgent).toBeDefined();

      // Main agent should be marked as main
      expect(mainAgent?.isMain).toBe(true);

      // Subagent should NOT be marked as main (it matched the claim)
      expect(subAgent?.isMain).toBe(false);

      // Display should show main agent usage (not 104% from claim mismatch)
      expect(mockStatusBarItem.text).toContain("52.0k/128.0k 41%");
    });

    it("main agent resumes correctly when pending claims exist (regression: claim misattribution)", () => {
      // This is a regression test for the bug where main agent's subsequent turns
      // were incorrectly attributed to pending subagent claims.
      // With conversationId-based identity, the main agent's turns share a
      // conversationId, so they always resume correctly regardless of claims.
      const mainHash = "main-system-hash";
      const mainTypeHash = "main-type-hash";
      const mainConversationId = "main-conv-id";

      // Main agent starts
      registry.startAgent({
        agentId: "main-agent",
        estimatedTokens: 50000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        systemPromptHash: mainHash,
        agentTypeHash: mainTypeHash,
        firstUserMessageHash: "first-user-msg",
        conversationId: mainConversationId,
      });
      registry.completeAgent("main-agent", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Create a claim for a subagent (e.g., "recon")
      registry.createChildClaim("main-agent", "recon");

      // Main agent makes another turn (same conversationId = resume)
      // This should NOT match the "recon" claim
      const resumedId = registry.startAgent({
        agentId: "main-agent-turn2",
        estimatedTokens: 55000,
        maxTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
        systemPromptHash: mainHash,
        agentTypeHash: mainTypeHash,
        firstUserMessageHash: "first-user-msg",
        conversationId: mainConversationId,
      });

      const agents = statusBar.getAgents();

      // Should still have only 1 agent (main agent resumed, not a new subagent)
      expect(agents.length).toBe(1);

      // The resumed agent should be the main agent
      const mainAgent = agents[0];
      expect(mainAgent?.isMain).toBe(true);
      expect(mainAgent?.name).toBe("claude-sonnet-4");

      // The agent ID should be aliased to the original main agent
      expect(resumedId).toBe("main-agent");

      // The "recon" claim should still be pending (not consumed)
      // We can verify this by starting a real subagent and seeing it gets the claim
      registry.startAgent({
        agentId: "recon-agent",
        estimatedTokens: 8000,
        maxTokens: 128000,
        modelId: "recon",
        systemPromptHash: "different-hash",
        agentTypeHash: "different-type",
        conversationId: "recon-conv-id",
      });

      const agentsAfter = statusBar.getAgents();
      const reconAgent = agentsAfter.find((a) => a.id === "recon-agent");
      expect(reconAgent).toBeDefined();
      expect(reconAgent?.isMain).toBe(false);
      expect(reconAgent?.name).toBe("recon");
    });
  });

  describe("Summarization detection", () => {
    it("detects summarization when tokens drop by 30%+", () => {
      // Use conversationId so second startAgent resumes the same agent
      registry.startAgent({
        agentId: "req-1",
        estimatedTokens: 80000,
        maxTokens: 128000,
        conversationId: "conv-summ",
      });
      registry.completeAgent("req-1", {
        inputTokens: 80000,
        outputTokens: 500,
      });

      // Second turn: tokens drop from 80k to 40k (50% drop)
      registry.startAgent({
        agentId: "req-2",
        estimatedTokens: 85000,
        maxTokens: 128000,
        conversationId: "conv-summ",
      });
      registry.completeAgent("req-2", {
        inputTokens: 40000,
        outputTokens: 600,
      });

      const agents = statusBar.getAgents();
      const agent = agents.find((a) => a.conversationId === "conv-summ");
      expect(agent?.summarizationDetected).toBe(true);
      expect(agent?.summarizationReduction).toBe(40000);
    });

    it("does not flag summarization for small token changes", () => {
      registry.startAgent({
        agentId: "req-1",
        estimatedTokens: 50000,
        maxTokens: 128000,
        conversationId: "conv-grow",
      });
      registry.completeAgent("req-1", {
        inputTokens: 50000,
        outputTokens: 500,
      });

      // Second turn: tokens increase slightly (normal growth)
      registry.startAgent({
        agentId: "req-2",
        estimatedTokens: 55000,
        maxTokens: 128000,
        conversationId: "conv-grow",
      });
      registry.completeAgent("req-2", {
        inputTokens: 55000,
        outputTokens: 600,
      });

      const agents = statusBar.getAgents();
      const agent = agents.find((a) => a.conversationId === "conv-grow");
      expect(agent?.summarizationDetected).toBeUndefined();
    });

    it("does not flag summarization for moderate drops (<30%)", () => {
      registry.startAgent({
        agentId: "req-1",
        estimatedTokens: 80000,
        maxTokens: 128000,
        conversationId: "conv-mod",
      });
      registry.completeAgent("req-1", {
        inputTokens: 80000,
        outputTokens: 500,
      });

      // Second turn: 20% drop (not enough to trigger)
      registry.startAgent({
        agentId: "req-2",
        estimatedTokens: 70000,
        maxTokens: 128000,
        conversationId: "conv-mod",
      });
      registry.completeAgent("req-2", {
        inputTokens: 64000,
        outputTokens: 600,
      });

      const agents = statusBar.getAgents();
      const agent = agents.find((a) => a.conversationId === "conv-mod");
      expect(agent?.summarizationDetected).toBeUndefined();
    });

    it("accumulates multiple summarization reductions", () => {
      registry.startAgent({
        agentId: "req-1",
        estimatedTokens: 80000,
        maxTokens: 128000,
        conversationId: "conv-multi",
      });
      registry.completeAgent("req-1", {
        inputTokens: 80000,
        outputTokens: 500,
      });

      // First summarization: 80k -> 30k
      registry.startAgent({
        agentId: "req-2",
        estimatedTokens: 35000,
        maxTokens: 128000,
        conversationId: "conv-multi",
      });
      registry.completeAgent("req-2", {
        inputTokens: 30000,
        outputTokens: 600,
      });

      // Context grows back up
      registry.startAgent({
        agentId: "req-3",
        estimatedTokens: 70000,
        maxTokens: 128000,
        conversationId: "conv-multi",
      });
      registry.completeAgent("req-3", {
        inputTokens: 70000,
        outputTokens: 700,
      });

      // Second summarization: 70k -> 25k
      registry.startAgent({
        agentId: "req-4",
        estimatedTokens: 30000,
        maxTokens: 128000,
        conversationId: "conv-multi",
      });
      registry.completeAgent("req-4", {
        inputTokens: 25000,
        outputTokens: 800,
      });

      const agents = statusBar.getAgents();
      const agent = agents.find((a) => a.conversationId === "conv-multi");
      expect(agent?.summarizationDetected).toBe(true);
      // 50000 (first) + 45000 (second) = 95000
      expect(agent?.summarizationReduction).toBe(95000);
    });

    it("fades compaction suffix after two turns", () => {
      registry.startAgent({
        agentId: "req-1",
        estimatedTokens: 80000,
        maxTokens: 128000,
        conversationId: "conv-fade",
      });
      registry.completeAgent("req-1", {
        inputTokens: 80000,
        outputTokens: 500,
        maxInputTokens: 128000,
      });

      registry.startAgent({
        agentId: "req-2",
        estimatedTokens: 85000,
        maxTokens: 128000,
        conversationId: "conv-fade",
      });
      registry.completeAgent("req-2", {
        inputTokens: 40000,
        outputTokens: 600,
        maxInputTokens: 128000,
      });

      expect(mockStatusBarItem.text).toContain("↓40.0k");

      registry.startAgent({
        agentId: "req-3",
        estimatedTokens: 50000,
        maxTokens: 128000,
        conversationId: "conv-fade",
      });
      registry.completeAgent("req-3", {
        inputTokens: 50000,
        outputTokens: 700,
        maxInputTokens: 128000,
      });

      expect(mockStatusBarItem.text).toContain("↓40.0k");

      registry.startAgent({
        agentId: "req-4",
        estimatedTokens: 60000,
        maxTokens: 128000,
        conversationId: "conv-fade",
      });
      registry.completeAgent("req-4", {
        inputTokens: 60000,
        outputTokens: 800,
        maxInputTokens: 128000,
      });

      expect(mockStatusBarItem.text).not.toContain("↓");
    });
  });
});
