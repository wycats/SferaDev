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
	StatusBarAlignment: {
		Left: 1,
		Right: 2,
	},
	ThemeColor: class ThemeColor {
		constructor(public id: string) {}
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
			statusBar.startAgent("agent-1", 50000, 128000, "anthropic:claude-sonnet-4");

			// Padded format: " 50.0k" (6 chars), "128.0k" (6 chars), " 39%" (4 chars)
			expect(mockStatusBarItem.text).toBe(`$(loading~spin) ~${fs}50.0k/128.0k (${fs}39%)`);
			expect(mockStatusBarItem.show).toHaveBeenCalled();
		});

		it("shows streaming without token info when no estimates", () => {
			statusBar.startAgent("agent-1");

			expect(mockStatusBarItem.text).toBe("$(loading~spin) streaming...");
			expect(mockStatusBarItem.show).toHaveBeenCalled();
		});

		it("extracts display name from model ID", () => {
			statusBar.startAgent("agent-1", 50000, 128000, "anthropic:claude-sonnet-4");
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
			expect(mockStatusBarItem.text).toBe(`$(symbol-number) ${fs}52.0k/128.0k`);
			expect(mockStatusBarItem.show).toHaveBeenCalled();
		});

		it("shows output tokens when configured", () => {
			statusBar.setConfig({ showOutputTokens: true });
			statusBar.startAgent("agent-1", 50000, 128000);
			statusBar.completeAgent("agent-1", {
				inputTokens: 52000,
				outputTokens: 1500,
				maxInputTokens: 128000,
			});

			// Padded format with output tokens
			expect(mockStatusBarItem.text).toBe(
				`$(symbol-number) ${fs}52.0k/128.0k (${fs}${fs}1.5k out)`,
			);
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
			expect(mockStatusBarItem.tooltip).toContain("8 tool uses cleared (15,200 freed)");
		});
	});

	describe("errorAgent", () => {
		it("marks agent as error", () => {
			statusBar.startAgent("agent-1", 50000, 128000);
			statusBar.errorAgent("agent-1");

			const agents = statusBar.getAgents();
			expect(agents[0].status).toBe("error");
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
			// First agent completes
			statusBar.startAgent("agent-1", 50000, 128000);
			statusBar.completeAgent("agent-1", {
				inputTokens: 50000,
				outputTokens: 1000,
			});

			// Two more agents complete
			statusBar.startAgent("agent-2", 30000, 128000);
			statusBar.completeAgent("agent-2", {
				inputTokens: 30000,
				outputTokens: 500,
			});

			statusBar.startAgent("agent-3", 20000, 128000);
			statusBar.completeAgent("agent-3", {
				inputTokens: 20000,
				outputTokens: 300,
			});

			const agents = statusBar.getAgents();
			const agent1 = agents.find((a) => a.id === "agent-1");
			expect(agent1?.dimmed).toBe(true);
		});

		it("removes agent after 5 newer completions", () => {
			// First agent completes
			statusBar.startAgent("agent-1", 50000, 128000);
			statusBar.completeAgent("agent-1", {
				inputTokens: 50000,
				outputTokens: 1000,
			});

			// Five more agents complete
			for (let i = 2; i <= 6; i++) {
				statusBar.startAgent(`agent-${i}`, 10000, 128000);
				statusBar.completeAgent(`agent-${i}`, {
					inputTokens: 10000,
					outputTokens: 100,
				});
			}

			const agents = statusBar.getAgents();
			const agent1 = agents.find((a) => a.id === "agent-1");
			expect(agent1).toBeUndefined();
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
			statusBar.startAgent("main-agent", 50000, 128000, "anthropic:claude-sonnet-4");
			statusBar.completeAgent("main-agent", {
				inputTokens: 52000,
				outputTokens: 1000,
				maxInputTokens: 128000,
			});

			// Subagent starts
			statusBar.startAgent("recon-agent", 8000, 128000, "recon");

			// Should show both agents - main uses x/max format, subagent shows name
			expect(mockStatusBarItem.text).toContain("52.0k/128.0k");
			expect(mockStatusBarItem.text).toContain("▸ recon");
		});

		it("shows tooltip with all agent details", () => {
			statusBar.startAgent("main-agent", 50000, 128000, "anthropic:claude-sonnet-4");
			statusBar.completeAgent("main-agent", {
				inputTokens: 52000,
				outputTokens: 1000,
				maxInputTokens: 128000,
				modelId: "anthropic:claude-sonnet-4",
			});

			expect(mockStatusBarItem.tooltip).toContain("claude-sonnet-4");
			expect(mockStatusBarItem.tooltip).toContain("52,000");
		});
	});
});
