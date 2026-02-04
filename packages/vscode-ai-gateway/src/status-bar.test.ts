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
      return { dispose: () => {} };
    };
    fire(data: T) {
      this.listeners.forEach((l) => l(data));
    }
    dispose() {}
  },
}));

// Import after mocking
import { TokenStatusBar } from "./status-bar";

describe("TokenStatusBar", () => {
  let statusBar: TokenStatusBar;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStatusBarItem.text = "";
    mockStatusBarItem.tooltip = "";
    mockStatusBarItem.backgroundColor = undefined;
    statusBar = new TokenStatusBar();
  });

  describe("startAgent", () => {
    // Figure space (U+2007) is used for padding to prevent status bar bouncing
    const fs = "\u2007";

    it("shows streaming indicator when agent starts", () => {
      statusBar.startAgent(
        "agent-1",
        50000,
        128000,
        "anthropic:claude-sonnet-4",
      );

      // Padded format: " 50.0k" (6 chars), "128.0k" (6 chars), " 39%" (4 chars)
      expect(mockStatusBarItem.text).toBe(
        `$(loading~spin) ~${fs}50.0k/128.0k (${fs}39%)`,
      );
      expect(mockStatusBarItem.show).toHaveBeenCalled();
    });

    it("shows streaming without token info when no estimates", () => {
      statusBar.startAgent("agent-1");

      expect(mockStatusBarItem.text).toBe("$(loading~spin) streaming...");
      expect(mockStatusBarItem.show).toHaveBeenCalled();
    });

    it("extracts display name from model ID", () => {
      statusBar.startAgent(
        "agent-1",
        50000,
        128000,
        "anthropic:claude-sonnet-4",
      );
      statusBar.completeAgent("agent-1", {
        inputTokens: 50000,
        outputTokens: 1000,
        maxInputTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
      });

      // Tooltip should contain the display name
      expect(mockStatusBarItem.tooltip).toContain("claude-sonnet-4");
    });
  });

  describe("completeAgent", () => {
    // Figure space (U+2007) is used for padding to prevent status bar bouncing
    const fs = "\u2007";

    it("shows usage after agent completes", () => {
      statusBar.startAgent("agent-1", 50000, 128000);
      statusBar.completeAgent("agent-1", {
        inputTokens: 52000,
        outputTokens: 1500,
        maxInputTokens: 128000,
      });

      // Padded format: " 52.0k" (6 chars), "128.0k" (6 chars)
      expect(mockStatusBarItem.text).toBe(`$(triangle-up) ${fs}52.0k/128.0k`);
      expect(mockStatusBarItem.show).toHaveBeenCalled();
    });

    it("stores usage for later retrieval", () => {
      statusBar.startAgent("agent-1");
      const usage = {
        inputTokens: 5000,
        outputTokens: 1000,
        maxInputTokens: 128000,
        modelId: "openai:gpt-4o",
      };
      statusBar.completeAgent("agent-1", usage);

      const lastUsage = statusBar.getLastUsage();
      expect(lastUsage?.inputTokens).toBe(5000);
      expect(lastUsage?.outputTokens).toBe(1000);
    });

    it("shows compaction info with fold icon and freed tokens", () => {
      // Figure space (U+2007) is used for padding to prevent status bar bouncing
      const fs = "\u2007";

      statusBar.startAgent("agent-1");
      statusBar.completeAgent("agent-1", {
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

      // Padded format with compaction suffix (unpadded for the compaction amount)
      expect(mockStatusBarItem.text).toBe(`$(fold) ${fs}37.1k/128.0k ↓15.2k`);
      expect(mockStatusBarItem.tooltip).toContain("⚡ Context compacted");
      expect(mockStatusBarItem.tooltip).toContain(
        "8 tool uses cleared (15,200 freed)",
      );
    });
  });

  describe("errorAgent", () => {
    it("marks agent as error", () => {
      statusBar.startAgent("agent-1", 50000, 128000);
      statusBar.errorAgent("agent-1");

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
      statusBar.startAgent("agent-1");
      statusBar.completeAgent("agent-1", {
        inputTokens: 100000,
        outputTokens: 500,
        maxInputTokens: 128000,
      });

      expect(mockStatusBarItem.backgroundColor).toBeDefined();
    });

    it("shows warning background at 90%+ usage", () => {
      statusBar.startAgent("agent-1");
      statusBar.completeAgent("agent-1", {
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
      statusBar.startAgent("agent-1");
      statusBar.completeAgent("agent-1", {
        inputTokens: 500,
        outputTokens: 100,
      });
      expect(mockStatusBarItem.text).toContain("500");
    });

    it("formats thousands with k suffix", () => {
      statusBar.startAgent("agent-1");
      statusBar.completeAgent("agent-1", {
        inputTokens: 5000,
        outputTokens: 100,
      });
      expect(mockStatusBarItem.text).toContain("5.0k");
    });

    it("formats millions with M suffix", () => {
      statusBar.startAgent("agent-1");
      statusBar.completeAgent("agent-1", {
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
      statusBar.startAgent(
        "agent-1",
        50000,
        128000,
        undefined,
        "main-hash",
        "type-1",
      );
      statusBar.completeAgent("agent-1", {
        inputTokens: 50000,
        outputTokens: 1000,
      });

      // Create claims for subagents (required for proper subagent detection)
      statusBar.createChildClaim("agent-1", "sub2");
      statusBar.createChildClaim("agent-1", "sub3");
      statusBar.createChildClaim("agent-1", "sub4");

      // Three subagents complete - first subagent should be dimmed after 2 newer completions
      statusBar.startAgent(
        "agent-2",
        30000,
        128000,
        undefined,
        "sub-hash",
        "type-2",
      );
      statusBar.completeAgent("agent-2", {
        inputTokens: 30000,
        outputTokens: 500,
      });

      statusBar.startAgent(
        "agent-3",
        20000,
        128000,
        undefined,
        "sub-hash",
        "type-3",
      );
      statusBar.completeAgent("agent-3", {
        inputTokens: 20000,
        outputTokens: 300,
      });

      statusBar.startAgent(
        "agent-4",
        15000,
        128000,
        undefined,
        "sub-hash",
        "type-4",
      );
      statusBar.completeAgent("agent-4", {
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
      statusBar.startAgent(
        "agent-1",
        50000,
        128000,
        undefined,
        "main-hash",
        "type-1",
      );
      statusBar.completeAgent("agent-1", {
        inputTokens: 50000,
        outputTokens: 1000,
      });

      // Create claims for all subagents (required for proper subagent detection)
      for (let i = 2; i <= 7; i++) {
        statusBar.createChildClaim("agent-1", `sub${i.toString()}`);
      }

      // Six subagents complete - first subagent should be removed after 5 newer completions
      for (let i = 2; i <= 7; i++) {
        statusBar.startAgent(
          `agent-${i.toString()}`,
          10000,
          128000,
          undefined,
          "sub-hash",
          `type-${i.toString()}`,
        );
        statusBar.completeAgent(`agent-${i.toString()}`, {
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
      statusBar.startAgent("agent-1", 50000, 128000);
      statusBar.startAgent("agent-2", 30000, 128000);

      statusBar.clearAgents();

      expect(statusBar.getAgents()).toHaveLength(0);
    });
  });

  describe("multi-agent display", () => {
    it("shows subagent alongside main agent when active", () => {
      // Main agent starts and completes (with maxInputTokens for consistent format)
      // Use a system prompt hash and agentTypeHash for proper subagent detection
      const mainHash = "main-system-prompt-hash-abc123";
      const subagentHash = "subagent-system-prompt-hash-xyz789";
      const mainTypeHash = "main-type-hash";
      const subTypeHash = "sub-type-hash";

      statusBar.startAgent(
        "main-agent",
        50000,
        128000,
        "anthropic:claude-sonnet-4",
        mainHash,
        mainTypeHash,
      );
      statusBar.completeAgent("main-agent", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Create a claim for the subagent (required for proper subagent detection)
      statusBar.createChildClaim("main-agent", "recon");

      // Subagent starts with different system prompt hash and matching claim
      statusBar.startAgent(
        "recon-agent",
        8000,
        128000,
        "recon",
        subagentHash,
        subTypeHash,
      );

      // Should show both agents - main uses x/max format, subagent shows "sub"
      // (subagent detection works via claim matching)
      expect(mockStatusBarItem.text).toContain("52.0k/128.0k");
      expect(mockStatusBarItem.text).toContain("▸ recon");
    });

    it("shows tooltip with all agent details", () => {
      statusBar.startAgent(
        "main-agent",
        50000,
        128000,
        "anthropic:claude-sonnet-4",
      );
      statusBar.completeAgent("main-agent", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
        modelId: "anthropic:claude-sonnet-4",
      });

      expect(mockStatusBarItem.tooltip).toContain("claude-sonnet-4");
      expect(mockStatusBarItem.tooltip).toContain("52,000");
    });

    it("detects subagent via claim even with identical hashes (regression: 104% bug)", () => {
      // This is a regression test for Issue #4: Subagent detection bypass causes 104% token display
      // The bug occurred when a subagent had the SAME system prompt hash and agent type hash
      // as the main agent, causing claim matching to be skipped entirely.
      const sameHash = "identical-hash-for-both";
      const sameTypeHash = "identical-type-hash";

      // Main agent starts with specific hashes
      statusBar.startAgent(
        "main-agent",
        50000,
        128000,
        "anthropic:claude-sonnet-4",
        sameHash,
        sameTypeHash,
      );
      statusBar.completeAgent("main-agent", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Create a claim for the subagent
      statusBar.createChildClaim("main-agent", "execute");

      // Subagent starts with IDENTICAL hashes (this was the bug trigger)
      // The claim should still be matched because we check claims FIRST
      statusBar.startAgent(
        "sub-agent",
        8000,
        128000,
        "execute",
        sameHash,
        sameTypeHash,
      );

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

      // Display should show both agents, not 104% (which would happen if subagent was treated as main)
      expect(mockStatusBarItem.text).toContain("52.0k/128.0k");
      expect(mockStatusBarItem.text).toContain("▸ execute");
    });

    it("main agent resumes correctly when pending claims exist (regression: claim misattribution)", () => {
      // This is a regression test for the bug where main agent's subsequent turns
      // were incorrectly attributed to pending subagent claims.
      // The bug occurred because:
      // 1. extractAgentName returns "sub" when isMain=false
      // 2. Claim matching has a FIFO fallback for "sub" agents
      // 3. Main agent's turn would match the first pending claim
      const mainHash = "main-system-hash";
      const mainTypeHash = "main-type-hash";

      // Main agent starts
      statusBar.startAgent(
        "main-agent",
        50000,
        128000,
        "anthropic:claude-sonnet-4",
        mainHash,
        mainTypeHash,
        "first-user-msg",
      );
      statusBar.completeAgent("main-agent", {
        inputTokens: 52000,
        outputTokens: 1000,
        maxInputTokens: 128000,
      });

      // Create a claim for a subagent (e.g., "recon")
      statusBar.createChildClaim("main-agent", "recon");

      // Main agent makes another turn (same hashes = resume)
      // This should NOT match the "recon" claim
      const resumedId = statusBar.startAgent(
        "main-agent-turn2",
        55000,
        128000,
        "anthropic:claude-sonnet-4",
        mainHash,
        mainTypeHash,
        "first-user-msg",
      );

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
      statusBar.startAgent(
        "recon-agent",
        8000,
        128000,
        "recon",
        "different-hash",
        "different-type",
      );

      const agentsAfter = statusBar.getAgents();
      const reconAgent = agentsAfter.find((a) => a.id === "recon-agent");
      expect(reconAgent).toBeDefined();
      expect(reconAgent?.isMain).toBe(false);
      expect(reconAgent?.name).toBe("recon");
    });
  });
});
