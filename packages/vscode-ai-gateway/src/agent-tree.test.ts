import { describe, it, expect, vi } from "vitest";
import * as vscode from "vscode";
import { AgentTreeItem } from "./agent-tree";
import type { AgentEntry } from "./status-bar";

// Mock vscode module
vi.mock("vscode", () => ({
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
  MarkdownString: class {
    value = "";
    isTrusted = false;
    appendMarkdown(text: string) {
      this.value += text;
    }
  },
  ThemeIcon: class {
    constructor(public id: string, public color?: unknown) {}
  },
  ThemeColor: class {
    constructor(public id: string) {}
  },
}));

function createMockAgent(overrides: Partial<AgentEntry> = {}): AgentEntry {
  return {
    id: "test-agent-id",
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

describe("AgentTreeItem", () => {
  describe("label selection", () => {
    it("uses generatedTitle when available", () => {
      const agent = createMockAgent({
        generatedTitle: "Login Bug Fix",
        firstUserMessagePreview: "Fix the bug in the login...",
        name: "claude-sonnet-4",
      });

      const item = new AgentTreeItem(agent, vscode.TreeItemCollapsibleState.None);

      expect(item.label).toBe("Login Bug Fix");
    });

    it("falls back to firstUserMessagePreview when no generatedTitle", () => {
      const agent = createMockAgent({
        generatedTitle: undefined,
        firstUserMessagePreview: "Fix the bug in the login...",
        name: "claude-sonnet-4",
      });

      const item = new AgentTreeItem(agent, vscode.TreeItemCollapsibleState.None);

      expect(item.label).toBe("Fix the bug in the login...");
    });

    it("falls back to name when no title or preview", () => {
      const agent = createMockAgent({
        generatedTitle: undefined,
        firstUserMessagePreview: undefined,
        name: "claude-sonnet-4",
      });

      const item = new AgentTreeItem(agent, vscode.TreeItemCollapsibleState.None);

      expect(item.label).toBe("claude-sonnet-4");
    });

    it("prefers generatedTitle over firstUserMessagePreview", () => {
      const agent = createMockAgent({
        generatedTitle: "AI Generated Title",
        firstUserMessagePreview: "User Message Preview",
        name: "model-name",
      });

      const item = new AgentTreeItem(agent, vscode.TreeItemCollapsibleState.None);

      expect(item.label).toBe("AI Generated Title");
    });
  });

  describe("contextValue", () => {
    it("sets mainAgent for main agents", () => {
      const agent = createMockAgent({ isMain: true });
      const item = new AgentTreeItem(agent, vscode.TreeItemCollapsibleState.None);

      expect(item.contextValue).toBe("mainAgent");
    });

    it("sets subAgent for subagents", () => {
      const agent = createMockAgent({ isMain: false });
      const item = new AgentTreeItem(agent, vscode.TreeItemCollapsibleState.None);

      expect(item.contextValue).toBe("subAgent");
    });
  });

  describe("description", () => {
    it("shows streaming status when streaming", () => {
      const agent = createMockAgent({
        status: "streaming",
        inputTokens: 0,
        outputTokens: 0,
        lastActualInputTokens: 0,
      });
      const item = new AgentTreeItem(agent, vscode.TreeItemCollapsibleState.None);

      expect(item.description).toBe("streaming...");
    });

    it("shows error status when error", () => {
      const agent = createMockAgent({ status: "error" });
      const item = new AgentTreeItem(agent, vscode.TreeItemCollapsibleState.None);

      expect(item.description).toBe("error");
    });

    it("shows token count and percentage when complete", () => {
      const agent = createMockAgent({
        status: "complete",
        inputTokens: 50000,
        lastActualInputTokens: 50000,
        maxInputTokens: 100000,
      });
      const item = new AgentTreeItem(agent, vscode.TreeItemCollapsibleState.None);

      // Format is "50.0k/100.0k · 50%"
      expect(item.description).toContain("50.0k");
      expect(item.description).toContain("100.0k");
      expect(item.description).toContain("50%");
    });
  });

  describe("tooltip", () => {
    it("includes title in tooltip when available", () => {
      const agent = createMockAgent({
        generatedTitle: "Login Bug Fix",
      });
      const item = new AgentTreeItem(agent, vscode.TreeItemCollapsibleState.None);

      const tooltip = item.tooltip as { value: string };
      expect(tooltip.value).toContain("Login Bug Fix");
    });

    it("includes model name in tooltip", () => {
      const agent = createMockAgent({
        name: "claude-sonnet-4",
      });
      const item = new AgentTreeItem(agent, vscode.TreeItemCollapsibleState.None);

      const tooltip = item.tooltip as { value: string };
      expect(tooltip.value).toContain("claude-sonnet-4");
    });
  });
});
