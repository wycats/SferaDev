/**
 * Tests for Tool History Manager
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	computeTruncation,
	estimateTokens,
	type ToolCallEntry,
	ToolHistoryManager,
} from "./tool-history.js";

describe("ToolHistoryManager", () => {
	let manager: ToolHistoryManager;

	beforeEach(() => {
		manager = new ToolHistoryManager({
			recentCallsToKeep: 3,
			maxHistorySummaryTokens: 500,
			preserveErrorsVerbatim: true,
			truncationThreshold: 1000,
		});
	});

	describe("addToolCall", () => {
		it("should add a tool call to history", () => {
			manager.addToolCall(
				"call_1",
				"read_file",
				{ filePath: "/src/foo.ts" },
				"export function foo() {}",
				false,
			);

			expect(manager.getHistoryLength()).toBe(1);
		});

		it("should categorize read operations correctly", () => {
			manager.addToolCall("call_1", "read_file", { filePath: "/src/foo.ts" }, "content", false);

			const result = manager.getCompactedHistory();
			expect(result.recentCalls[0].callText).toContain("read_file");
		});

		it("should categorize write operations correctly", () => {
			manager.addToolCall(
				"call_1",
				"create_file",
				{ filePath: "/src/new.ts", content: "// new file" },
				"File created",
				false,
			);

			const result = manager.getCompactedHistory();
			expect(result.recentCalls[0].callText).toContain("create_file");
		});
	});

	describe("getTotalTokens", () => {
		it("should estimate token count for all entries", () => {
			manager.addToolCall("call_1", "read_file", { path: "/a.ts" }, "short", false);
			manager.addToolCall(
				"call_2",
				"read_file",
				{ path: "/b.ts" },
				"this is a much longer result that should count more tokens",
				false,
			);

			const tokens = manager.getTotalTokens();
			expect(tokens).toBeGreaterThan(0);
		});
	});

	describe("shouldTruncate", () => {
		it("should return false when below threshold", () => {
			manager.addToolCall("call_1", "read_file", { path: "/a.ts" }, "short", false);
			expect(manager.shouldTruncate()).toBe(false);
		});

		it("should return true when exceeding threshold", () => {
			// Add many calls to exceed 1000 token threshold
			for (let i = 0; i < 50; i++) {
				manager.addToolCall(
					`call_${i}`,
					"read_file",
					{ filePath: `/src/file${i}.ts` },
					"A".repeat(200), // ~50 tokens per call
					false,
				);
			}
			expect(manager.shouldTruncate()).toBe(true);
		});
	});

	describe("getCompactedHistory", () => {
		it("should return all entries when count is below recentCallsToKeep", () => {
			manager.addToolCall("call_1", "read_file", { path: "/a.ts" }, "result1", false);
			manager.addToolCall("call_2", "read_file", { path: "/b.ts" }, "result2", false);

			const result = manager.getCompactedHistory();

			expect(result.summary).toBeNull();
			expect(result.recentCalls).toHaveLength(2);
			expect(result.truncatedCount).toBe(0);
			expect(result.originalCount).toBe(2);
		});

		it("should truncate older calls and provide summary", () => {
			// Add more calls than recentCallsToKeep (3)
			manager.addToolCall("call_1", "read_file", { filePath: "/a.ts" }, "result1", false);
			manager.addToolCall("call_2", "read_file", { filePath: "/b.ts" }, "result2", false);
			manager.addToolCall("call_3", "read_file", { filePath: "/c.ts" }, "result3", false);
			manager.addToolCall("call_4", "read_file", { filePath: "/d.ts" }, "result4", false);
			manager.addToolCall("call_5", "read_file", { filePath: "/e.ts" }, "result5", false);

			const result = manager.getCompactedHistory();

			expect(result.summary).not.toBeNull();
			expect(result.summary).toContain("[Earlier in this session:]");
			expect(result.summary).toContain("Read 2 file(s)");
			expect(result.recentCalls).toHaveLength(3);
			expect(result.truncatedCount).toBe(2);
			expect(result.originalCount).toBe(5);
		});

		it("should preserve errors in summary when configured", () => {
			manager.addToolCall(
				"call_1",
				"run_in_terminal",
				{ command: "npm test" },
				"FAIL: test.ts:10 Error",
				true,
			);
			manager.addToolCall("call_2", "read_file", { filePath: "/a.ts" }, "result", false);
			manager.addToolCall("call_3", "read_file", { filePath: "/b.ts" }, "result", false);
			manager.addToolCall("call_4", "read_file", { filePath: "/c.ts" }, "result", false);
			manager.addToolCall("call_5", "read_file", { filePath: "/d.ts" }, "result", false);

			const result = manager.getCompactedHistory();

			expect(result.summary).toContain("[Errors encountered:]");
			expect(result.summary).toContain("run_in_terminal");
			expect(result.summary).toContain("FAIL: test.ts:10");
		});

		it("should format tool calls correctly", () => {
			manager.addToolCall(
				"call_abc123",
				"read_file",
				{ filePath: "/src/foo.ts", startLine: 1, endLine: 50 },
				"export function foo() {}",
				false,
			);

			const result = manager.getCompactedHistory();
			const entry = result.recentCalls[0];

			// NOTE: We use HTML comment format to prevent models from mimicking the
			// format and outputting tool calls as text instead of using the actual
			// tool calling mechanism.
			expect(entry.callText).toBe(
				'<!-- prior-tool: read_file | id: call_abc123 | args: {"filePath":"/src/foo.ts","startLine":1,"endLine":50} -->',
			);
			expect(entry.resultText).toBe(
				"<!-- prior-tool-result: call_abc123 -->\nexport function foo() {}",
			);
		});

		it("should group different categories in summary", () => {
			manager.addToolCall("call_1", "read_file", { filePath: "/a.ts" }, "content", false);
			manager.addToolCall("call_2", "create_file", { filePath: "/b.ts" }, "created", false);
			manager.addToolCall("call_3", "run_in_terminal", { command: "npm test" }, "passed", false);
			manager.addToolCall("call_4", "semantic_search", { query: "auth" }, "results", false);
			// These 3 will be in recentCalls, not summary
			manager.addToolCall("call_5", "read_file", { filePath: "/c.ts" }, "content", false);
			manager.addToolCall("call_6", "read_file", { filePath: "/d.ts" }, "content", false);
			manager.addToolCall("call_7", "read_file", { filePath: "/e.ts" }, "content", false);

			const result = manager.getCompactedHistory();

			// Summary should contain the first 4 calls grouped by category
			expect(result.summary).toContain("Read 1 file");
			expect(result.summary).toContain("edit");
			expect(result.summary).toContain("terminal");
			expect(result.summary).toContain("search");
			expect(result.truncatedCount).toBe(4);
		});
	});

	describe("clear", () => {
		it("should clear all history", () => {
			manager.addToolCall("call_1", "read_file", { path: "/a.ts" }, "result", false);
			manager.addToolCall("call_2", "read_file", { path: "/b.ts" }, "result", false);

			manager.clear();

			expect(manager.getHistoryLength()).toBe(0);
			expect(manager.getTotalTokens()).toBe(0);
		});
	});

	describe("edge cases", () => {
		it("should handle empty history", () => {
			const result = manager.getCompactedHistory();

			expect(result.summary).toBeNull();
			expect(result.recentCalls).toHaveLength(0);
			expect(result.truncatedCount).toBe(0);
			expect(result.originalCount).toBe(0);
		});

		it("should handle tools with missing args", () => {
			manager.addToolCall("call_1", "get_time", {}, "14:30", false);

			const result = manager.getCompactedHistory();
			expect(result.recentCalls[0].callText).toContain("<!-- prior-tool: get_time");
		});

		it("should truncate long error messages in summary", () => {
			const longError = "E".repeat(500);
			manager.addToolCall("call_1", "run_in_terminal", { command: "fail" }, longError, true);
			manager.addToolCall("call_2", "read_file", { filePath: "/a.ts" }, "ok", false);
			manager.addToolCall("call_3", "read_file", { filePath: "/b.ts" }, "ok", false);
			manager.addToolCall("call_4", "read_file", { filePath: "/c.ts" }, "ok", false);
			manager.addToolCall("call_5", "read_file", { filePath: "/d.ts" }, "ok", false);

			const result = manager.getCompactedHistory();

			// Error in summary should be truncated
			expect(result.summary).toContain("...");
			expect(result.summary?.length).toBeLessThan(longError.length);
		});
	});
});

describe("computeTruncation", () => {
	function makeEntry(
		callId: string,
		name: string,
		args: Record<string, unknown> = {},
		result = "result",
		isError = false,
	): ToolCallEntry {
		const content = `${name} ${JSON.stringify(args)} ${result}`;
		return {
			callId,
			name,
			args,
			result,
			isError,
			timestamp: Date.now(),
			tokenCount: estimateTokens(content),
			category: name.includes("read") ? "read" : name.includes("terminal") ? "terminal" : "other",
		};
	}

	it("should not truncate when below threshold", () => {
		const entries = [
			makeEntry("call_1", "read_file", { path: "/a.ts" }),
			makeEntry("call_2", "read_file", { path: "/b.ts" }),
		];

		const decision = computeTruncation(entries, { truncationThreshold: 10000 });

		expect(decision.shouldTruncate).toBe(false);
		expect(decision.summary).toBeNull();
		expect(decision.recentCallIds.size).toBe(2);
		expect(decision.truncatedCallIds.size).toBe(0);
	});

	it("should truncate when exceeding threshold", () => {
		// Create entries with enough tokens to exceed threshold
		const entries = Array.from({ length: 20 }, (_, i) =>
			makeEntry(`call_${i}`, "read_file", { filePath: `/src/file${i}.ts` }, "A".repeat(200)),
		);

		const decision = computeTruncation(entries, {
			truncationThreshold: 500,
			recentCallsToKeep: 3,
		});

		expect(decision.shouldTruncate).toBe(true);
		expect(decision.summary).not.toBeNull();
		expect(decision.summary).toContain("[Earlier in this session:]");
		expect(decision.recentCallIds.size).toBe(3);
		expect(decision.truncatedCallIds.size).toBe(17);
		expect(decision.tokensSaved).toBeGreaterThan(0);
	});

	it("should identify which call IDs to keep", () => {
		const entries = [
			makeEntry("call_old_1", "read_file", {}, "A".repeat(100)),
			makeEntry("call_old_2", "read_file", {}, "A".repeat(100)),
			makeEntry("call_recent_1", "read_file", {}, "A".repeat(100)),
			makeEntry("call_recent_2", "read_file", {}, "A".repeat(100)),
		];

		const decision = computeTruncation(entries, {
			truncationThreshold: 50, // Force truncation
			recentCallsToKeep: 2,
		});

		expect(decision.recentCallIds.has("call_recent_1")).toBe(true);
		expect(decision.recentCallIds.has("call_recent_2")).toBe(true);
		expect(decision.truncatedCallIds.has("call_old_1")).toBe(true);
		expect(decision.truncatedCallIds.has("call_old_2")).toBe(true);
	});

	it("should handle empty entries", () => {
		const decision = computeTruncation([]);

		expect(decision.shouldTruncate).toBe(false);
		expect(decision.summary).toBeNull();
		expect(decision.recentCallIds.size).toBe(0);
	});
});

describe("estimateTokens", () => {
	it("should estimate tokens based on character count", () => {
		expect(estimateTokens("test")).toBe(1); // 4 chars = 1 token
		expect(estimateTokens("longer text")).toBe(3); // 11 chars = ~3 tokens
		expect(estimateTokens("A".repeat(100))).toBe(25); // 100 chars = 25 tokens
	});
});
