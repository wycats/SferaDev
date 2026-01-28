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

	describe("showStreaming", () => {
		it("shows streaming indicator without token info", () => {
			statusBar.showStreaming();

			expect(mockStatusBarItem.text).toBe("$(loading~spin) Streaming...");
			expect(mockStatusBarItem.show).toHaveBeenCalled();
		});

		it("shows streaming indicator with estimated tokens", () => {
			statusBar.showStreaming(50000, 128000);

			expect(mockStatusBarItem.text).toBe("$(loading~spin) ~50.0k/128.0k (39%)");
			expect(mockStatusBarItem.show).toHaveBeenCalled();
		});

		it("shows high percentage correctly", () => {
			statusBar.showStreaming(115000, 128000);

			expect(mockStatusBarItem.text).toBe("$(loading~spin) ~115.0k/128.0k (90%)");
		});
	});

	describe("showUsage", () => {
		it("shows basic usage without max tokens", () => {
			statusBar.showUsage({
				inputTokens: 1500,
				outputTokens: 500,
			});

			expect(mockStatusBarItem.text).toBe("$(symbol-number) 1.5k in, 500 out");
			expect(mockStatusBarItem.show).toHaveBeenCalled();
		});

		it("shows usage with max tokens and percentage", () => {
			statusBar.showUsage({
				inputTokens: 50000,
				outputTokens: 1000,
				maxInputTokens: 128000,
			});

			expect(mockStatusBarItem.text).toBe("$(symbol-number) 50.0k/128.0k (1.0k out)");
			expect(mockStatusBarItem.backgroundColor).toBeUndefined();
		});

		it("shows warning background at 75%+ usage", () => {
			statusBar.showUsage({
				inputTokens: 100000,
				outputTokens: 500,
				maxInputTokens: 128000,
			});

			expect(mockStatusBarItem.backgroundColor).toBeDefined();
		});

		it("shows warning background at 90%+ usage", () => {
			statusBar.showUsage({
				inputTokens: 120000,
				outputTokens: 500,
				maxInputTokens: 128000,
			});

			expect(mockStatusBarItem.backgroundColor).toBeDefined();
		});

		it("stores usage for later retrieval", () => {
			const usage = {
				inputTokens: 5000,
				outputTokens: 1000,
				maxInputTokens: 128000,
				modelId: "openai:gpt-4o",
			};

			statusBar.showUsage(usage);

			expect(statusBar.getLastUsage()).toEqual(usage);
		});

		it("shows compaction info with fold icon and freed tokens", () => {
			statusBar.showUsage({
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

			expect(mockStatusBarItem.text).toBe("$(fold) 37.1k/128.0k (1.2k out) ↓15.2k");
			expect(mockStatusBarItem.tooltip).toContain("⚡ Context compacted");
			expect(mockStatusBarItem.tooltip).toContain("- 8 tool uses cleared (15,200 freed)");
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

	describe("hide", () => {
		it("hides the status bar", () => {
			statusBar.hide();

			expect(mockStatusBarItem.hide).toHaveBeenCalled();
		});
	});

	describe("formatTokenCount", () => {
		it("formats small numbers as-is", () => {
			statusBar.showUsage({ inputTokens: 500, outputTokens: 100 });
			expect(mockStatusBarItem.text).toContain("500");
		});

		it("formats thousands with k suffix", () => {
			statusBar.showUsage({ inputTokens: 5000, outputTokens: 100 });
			expect(mockStatusBarItem.text).toContain("5.0k");
		});

		it("formats millions with M suffix", () => {
			statusBar.showUsage({ inputTokens: 1500000, outputTokens: 100 });
			expect(mockStatusBarItem.text).toContain("1.5M");
		});
	});

	describe("dispose", () => {
		it("disposes the status bar item", () => {
			statusBar.dispose();

			expect(mockStatusBarItem.dispose).toHaveBeenCalled();
		});
	});

	describe("session tracking", () => {
		it("generates unique session IDs", () => {
			const id1 = statusBar.generateSessionId();
			const id2 = statusBar.generateSessionId();

			expect(id1).toMatch(/^session-\d+-[a-z0-9]+$/);
			expect(id2).toMatch(/^session-\d+-[a-z0-9]+$/);
			expect(id1).not.toBe(id2);
		});

		it("starts a new session", () => {
			const sessionId = statusBar.startSession(undefined, 50000, 128000);

			expect(sessionId).toBeDefined();
			expect(statusBar.getActiveSessionId()).toBe(sessionId);
			expect(statusBar.getSessions()).toHaveLength(1);
		});

		it("joins an existing session with same ID", () => {
			const sessionId = statusBar.startSession("test-session", 50000, 128000);
			statusBar.showUsage(
				{ inputTokens: 50000, outputTokens: 1000, maxInputTokens: 128000 },
				sessionId,
			);

			// Join the same session (simulating subagent)
			statusBar.startSession("test-session", 30000, 128000);

			const sessions = statusBar.getSessions();
			expect(sessions).toHaveLength(1);
			expect(sessions[0].requestCount).toBe(2);
			expect(sessions[0].inputTokens).toBe(50000); // From first showUsage
		});

		it("accumulates tokens across requests in a session", () => {
			const sessionId = statusBar.startSession("test-session", 50000, 128000);

			// First request completes
			statusBar.showUsage(
				{ inputTokens: 50000, outputTokens: 1000, maxInputTokens: 128000 },
				sessionId,
			);

			// Second request (subagent) joins and completes
			statusBar.startSession("test-session", 30000, 128000);
			statusBar.showUsage(
				{ inputTokens: 30000, outputTokens: 500, maxInputTokens: 128000 },
				sessionId,
			);

			const sessions = statusBar.getSessions();
			expect(sessions[0].inputTokens).toBe(80000);
			expect(sessions[0].outputTokens).toBe(1500);
			expect(sessions[0].requestCount).toBe(2);
		});

		it("shows session totals in display for multi-request sessions", () => {
			const sessionId = statusBar.startSession("test-session", 50000, 128000);
			statusBar.showUsage(
				{ inputTokens: 50000, outputTokens: 1000, maxInputTokens: 128000 },
				sessionId,
			);

			// Second request
			statusBar.startSession("test-session", 30000, 128000);
			statusBar.showUsage(
				{ inputTokens: 30000, outputTokens: 500, maxInputTokens: 128000 },
				sessionId,
			);

			// Should show session total indicator [Σ80k]
			expect(mockStatusBarItem.text).toContain("[Σ80.0k]");
		});

		it("clears all sessions", () => {
			statusBar.startSession("session-1", 50000, 128000);
			statusBar.startSession("session-2", 30000, 128000);

			statusBar.clearSessions();

			expect(statusBar.getSessions()).toHaveLength(0);
			expect(statusBar.getActiveSessionId()).toBeNull();
		});

		it("marks session as error", () => {
			const sessionId = statusBar.startSession("test-session", 50000, 128000);
			statusBar.markSessionError(sessionId);

			const sessions = statusBar.getSessions();
			expect(sessions[0].status).toBe("error");
		});

		it("updates streaming progress", () => {
			statusBar.startSession("test-session", 50000, 128000);
			statusBar.updateStreamingProgress(500);

			expect(mockStatusBarItem.text).toContain("500 out");
		});

		it("gets session totals for non-dimmed sessions", () => {
			const sessionId = statusBar.startSession("test-session", 50000, 128000);
			statusBar.showUsage(
				{ inputTokens: 50000, outputTokens: 1000, maxInputTokens: 128000 },
				sessionId,
			);

			const totals = statusBar.getSessionTotals();
			expect(totals.inputTokens).toBe(50000);
			expect(totals.outputTokens).toBe(1000);
		});
	});
});
