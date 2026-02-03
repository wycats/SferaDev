import { describe, expect, it } from "vitest";
import type { FormattedToolEntry } from "./tool-history.js";
import { ToolHistoryManager } from "./tool-history.js";
import { NativeStrategy, TextEmbedStrategy } from "./tool-history-strategy.js";

describe("ToolHistoryStrategy", () => {
  describe("TextEmbedStrategy", () => {
    it("renders tool results as user messages", () => {
      const strategy = new TextEmbedStrategy();
      const entry: FormattedToolEntry = {
        callText: "<!-- prior-tool: read_file | id: call_123 | args: {} -->",
        resultText: "<!-- prior-tool-result: call_123 -->\nfile contents",
        isError: false,
      };

      const items = strategy.renderEntry(entry);

      expect(items).toHaveLength(1);
      const item = items[0];
      if (item?.type !== "message") {
        throw new Error("Expected a message item");
      }
      const contentPart = item.content[0];
      if (!contentPart || typeof contentPart === "string") {
        throw new Error("Expected input_text content");
      }
      if (contentPart.type !== "input_text") {
        throw new Error("Expected input_text content");
      }
      expect(item.role).toBe("user");
      expect(contentPart.text).toBe("Context (tool result):\nfile contents");
    });

    it("skips empty summaries", () => {
      const strategy = new TextEmbedStrategy();

      expect(strategy.renderSummary("")).toEqual([]);
    });
  });

  describe("NativeStrategy", () => {
    it("parses HTML comments into native tool items", () => {
      const strategy = new NativeStrategy();
      const entry: FormattedToolEntry = {
        callText:
          '<!-- prior-tool: read_file | id: call_abc | args: {"filePath":"/src/a.ts"} -->',
        resultText: "<!-- prior-tool-result: call_abc -->\nexport const a = 1;",
        isError: false,
      };

      const items = strategy.renderEntry(entry);

      expect(items).toHaveLength(2);
      const callItem = items[0];
      const outputItem = items[1];
      if (callItem?.type !== "function_call") {
        throw new Error("Expected function_call item");
      }
      if (outputItem?.type !== "function_call_output") {
        throw new Error("Expected function_call_output item");
      }
      expect(callItem.call_id).toBe("call_abc");
      expect(callItem.name).toBe("read_file");
      expect(callItem.arguments).toBe('{"filePath":"/src/a.ts"}');
      expect(outputItem.call_id).toBe("call_abc");
      expect(outputItem.output).toBe("export const a = 1;");
    });

    it("falls back to text-embed on parse failure", () => {
      const strategy = new NativeStrategy();
      const entry: FormattedToolEntry = {
        callText: "[Tool Call: read_file]",
        resultText: "<!-- prior-tool-result: call_123 -->\nfile contents",
        isError: false,
      };

      const items = strategy.renderEntry(entry);

      expect(items).toHaveLength(1);
      const item = items[0];
      if (item?.type !== "message") {
        throw new Error("Expected fallback message item");
      }
      const contentPart = item.content[0];
      if (!contentPart || typeof contentPart === "string") {
        throw new Error("Expected input_text content");
      }
      if (contentPart.type !== "input_text") {
        throw new Error("Expected input_text content");
      }
      expect(contentPart.text).toBe("Context (tool result):\nfile contents");
    });
  });

  describe("ToolHistoryManager.renderAsItems", () => {
    it("renders summary and recent entries using strategy", () => {
      const manager = new ToolHistoryManager({ recentCallsToKeep: 1 });

      manager.addToolCall(
        "call_1",
        "read_file",
        { filePath: "/a.ts" },
        "result1",
        false,
      );
      manager.addToolCall(
        "call_2",
        "read_file",
        { filePath: "/b.ts" },
        "result2",
        false,
      );
      manager.addToolCall(
        "call_3",
        "read_file",
        { filePath: "/c.ts" },
        "result3",
        false,
      );

      const compacted = manager.getCompactedHistory();
      const items = manager.renderAsItems();

      expect(compacted.summary).not.toBeNull();
      expect(items).toHaveLength(2);
      const summaryItem = items[0];
      const entryItem = items[1];
      if (summaryItem?.type !== "message") {
        throw new Error("Expected summary message item");
      }
      if (entryItem?.type !== "message") {
        throw new Error("Expected entry message item");
      }
      const summaryContent = summaryItem.content[0];
      if (!summaryContent || typeof summaryContent === "string") {
        throw new Error("Expected summary input_text content");
      }
      if (summaryContent.type !== "input_text") {
        throw new Error("Expected summary input_text content");
      }
      const entryContent = entryItem.content[0];
      if (!entryContent || typeof entryContent === "string") {
        throw new Error("Expected entry input_text content");
      }
      if (entryContent.type !== "input_text") {
        throw new Error("Expected entry input_text content");
      }
      expect(summaryContent.text).toBe(compacted.summary);
      expect(entryContent.text).toContain("Context (tool result):");
    });
  });
});
