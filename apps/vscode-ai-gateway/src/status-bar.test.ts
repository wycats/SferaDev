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
});
