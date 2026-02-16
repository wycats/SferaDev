import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  TreeItem: class TreeItem {
    label: string | undefined;
    description: string | undefined;
    tooltip: unknown;
    iconPath: unknown;
    contextValue: string | undefined;
    collapsibleState: number | undefined;
    constructor(label: string, collapsibleState?: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class ThemeIcon {
    id: string;
    color: unknown;
    constructor(id: string, color?: unknown) {
      this.id = id;
      this.color = color;
    }
  },
  ThemeColor: class ThemeColor {
    id: string;
    constructor(id: string) {
      this.id = id;
    }
  },
  MarkdownString: class MarkdownString {
    value = "";
    isTrusted = false;
    appendMarkdown(text: string) {
      this.value += text;
    }
  },
}));

import type {
  AIResponseEntry,
  CompactionEntry,
  ErrorEntry,
  Subagent,
  UserMessageEntry,
} from "./types";
import {
  AIResponseItem,
  CompactionTreeItem,
  ErrorTreeItem,
  ConversationItem,
  SubagentItem,
  HistoryItem,
  SectionHeaderItem,
  ToolContinuationItem,
  UserMessageItem,
  type UserMessageChild,
} from "./tree-items";
import type { ActivityLogEntry, Conversation } from "./types";

describe("UserMessageItem", () => {
  const testConversationId = "test-conv-123";

  it("shows preview as label when available", () => {
    const entry: UserMessageEntry = {
      type: "user-message",
      sequenceNumber: 3,
      timestamp: Date.now(),
      preview: "Refactored auth middleware",
    };

    const item = new UserMessageItem(entry, testConversationId);
    expect(item.label).toBe("Refactored auth middleware");
    expect(item.description).toBe("#3");
    expect((item.iconPath as { id: string }).id).toBe("feedback");
  });

  it("falls back to Message #N label without preview", () => {
    const entry: UserMessageEntry = {
      type: "user-message",
      sequenceNumber: 5,
      timestamp: Date.now(),
    };

    const item = new UserMessageItem(entry, testConversationId);
    expect(item.label).toBe("Message #5");
    // No description when there's no preview (would be redundant with label)
    expect(item.description).toBe("");
  });

  // NOTE: Tool continuations are now rendered as ToolContinuationItem, not UserMessageItem.
  // See ToolContinuationItem tests below.

  it("is collapsible when children are provided", () => {
    const entry: UserMessageEntry = {
      type: "user-message",
      sequenceNumber: 1,
      timestamp: Date.now(),
      preview: "Fix the bug",
    };
    const children: UserMessageChild[] = [
      {
        type: "ai-response",
        entry: {
          type: "ai-response",
          sequenceNumber: 1,
          timestamp: Date.now(),
          state: "characterized",
          characterization: "Fixed the auth bug",
          tokenContribution: 500,
          subagentIds: [],
        },
      },
    ];

    const item = new UserMessageItem(entry, testConversationId, children);
    // TreeItemCollapsibleState.Expanded = 2
    expect(item.collapsibleState).toBe(2);
    expect(item.children).toHaveLength(1);
    expect(item.conversationId).toBe(testConversationId);
  });

  it("is not collapsible when no children", () => {
    const entry: UserMessageEntry = {
      type: "user-message",
      sequenceNumber: 1,
      timestamp: Date.now(),
    };

    const item = new UserMessageItem(entry, testConversationId, []);
    // TreeItemCollapsibleState.None = 0
    expect(item.collapsibleState).toBe(0);
    expect(item.children).toHaveLength(0);
  });
});

describe("ToolContinuationItem", () => {
  const testConversationId = "test-conv-123";

  it("shows Tools #N when no tool names provided", () => {
    const entry: UserMessageEntry = {
      type: "user-message",
      sequenceNumber: 4,
      timestamp: Date.now(),
      isToolContinuation: true,
    };

    const item = new ToolContinuationItem(entry, testConversationId, []);
    expect(item.label).toBe("Tools #4");
    expect(item.description).toBe("#4");
    expect((item.iconPath as { id: string }).id).toBe("tools");
    expect(item.contextValue).toBe("tool-continuation");
  });

  it("shows tool names as label when provided", () => {
    const entry: UserMessageEntry = {
      type: "user-message",
      sequenceNumber: 3,
      timestamp: Date.now(),
      isToolContinuation: true,
    };

    const item = new ToolContinuationItem(entry, testConversationId, [
      "read_file",
      "grep_search",
    ]);
    expect(item.label).toBe("read_file, grep_search");
    expect(item.description).toBe("#3");
  });

  it("abbreviates when more than 3 tools", () => {
    const entry: UserMessageEntry = {
      type: "user-message",
      sequenceNumber: 5,
      timestamp: Date.now(),
      isToolContinuation: true,
    };

    const item = new ToolContinuationItem(entry, testConversationId, [
      "read_file",
      "grep_search",
      "list_dir",
      "run_in_terminal",
    ]);
    expect(item.label).toBe("read_file, grep_search, list_dir+1");
  });

  it("shows token contribution in description", () => {
    const entry: UserMessageEntry = {
      type: "user-message",
      sequenceNumber: 2,
      timestamp: Date.now(),
      isToolContinuation: true,
      tokenContribution: 1500,
    };

    const item = new ToolContinuationItem(entry, testConversationId, [
      "read_file",
    ]);
    expect(item.label).toBe("read_file");
    expect(item.description).toBe("#2 · +1.5k");
    expect((item.iconPath as { id: string }).id).toBe("tools");
  });
});

describe("AIResponseItem", () => {
  it("shows characterization as label when available", () => {
    const response: AIResponseEntry = {
      type: "ai-response",
      sequenceNumber: 3,
      timestamp: Date.now(),
      characterization: "Refactored auth middleware",
      tokenContribution: 2100,
      subagentIds: [],
      state: "characterized",
    };

    const item = new AIResponseItem(response, "conv-1", []);
    expect(item.label).toBe("Refactored auth middleware");
    expect(item.description).toBe("#3 · +2.1k");
    expect((item.iconPath as { id: string }).id).toBe("chat-sparkle");
  });

  it("falls back to Response #N label without characterization", () => {
    const response: AIResponseEntry = {
      type: "ai-response",
      sequenceNumber: 5,
      // Use old timestamp so it's past the pending timeout
      timestamp: Date.now() - 60_000,
      tokenContribution: 800,
      subagentIds: [],
      state: "uncharacterized",
    };

    const item = new AIResponseItem(response, "conv-1", []);
    expect(item.label).toBe("Response #5");
    // No #N in description when there's no characterization (would be redundant)
    expect(item.description).toBe("+800");
  });

  it("shows streaming icon for streaming responses", () => {
    const response: AIResponseEntry = {
      type: "ai-response",
      sequenceNumber: 1,
      timestamp: Date.now(),
      tokenContribution: 0,
      subagentIds: [],
      state: "streaming",
    };

    const item = new AIResponseItem(response, "conv-1", []);
    expect((item.iconPath as { id: string }).id).toBe("loading~spin");
  });

  it("shows muted icon when characterization is pending", () => {
    const response: AIResponseEntry = {
      type: "ai-response",
      sequenceNumber: 2,
      timestamp: Date.now(),
      tokenContribution: 500,
      subagentIds: [],
      state: "pending-characterization",
    };

    const item = new AIResponseItem(response, "conv-1", []);
    // Pending shows muted sparkle (no spinner), label shows ellipsis
    expect((item.iconPath as { id: string }).id).toBe("chat-sparkle");
    expect(item.label).toBe("#2 ⋯");
  });

  it("is collapsible when it has subagents", () => {
    const response: AIResponseEntry = {
      type: "ai-response",
      sequenceNumber: 2,
      timestamp: Date.now(),
      tokenContribution: 1500,
      subagentIds: ["sub-1"],
      state: "characterized",
    };

    const subagents = [
      {
        conversationId: "sub-1",
        name: "recon",
        tokens: { input: 100, output: 50 },
        turnCount: 1,
        status: "complete" as const,
        children: [],
      },
    ];

    const item = new AIResponseItem(response, "conv-1", subagents);
    expect(item.collapsibleState).toBe(1); // Collapsed
  });
});

describe("CompactionTreeItem", () => {
  it("formats summarization compaction label", () => {
    const entry: CompactionEntry = {
      type: "compaction",
      timestamp: Date.now(),
      turnNumber: 8,
      freedTokens: 30000,
      compactionType: "summarization",
    };

    const item = new CompactionTreeItem(entry);
    expect(item.label).toBe("↓ Compacted 30.0k (turn 8)");
    expect((item.iconPath as { id: string }).id).toBe("fold-down");
    expect(item.contextValue).toBe("compaction");
  });

  it("formats context management compaction label", () => {
    const entry: CompactionEntry = {
      type: "compaction",
      timestamp: Date.now(),
      turnNumber: 3,
      freedTokens: 5000,
      compactionType: "context_management",
      details: "edits:2",
    };

    const item = new CompactionTreeItem(entry);
    expect(item.label).toBe("↓ Context managed 5.0k (turn 3)");
    expect(item.tooltip).toBe("edits:2");
  });
});

describe("ErrorTreeItem", () => {
  it("formats error with message", () => {
    const entry: ErrorEntry = {
      type: "error",
      timestamp: Date.now(),
      turnNumber: 5,
      message: "Rate limit exceeded",
    };

    const item = new ErrorTreeItem(entry);
    expect(item.label).toBe("✗ Rate limit exceeded");
    expect((item.iconPath as { id: string }).id).toBe("error");
    expect(item.contextValue).toBe("error");
  });

  it("truncates long error messages", () => {
    const entry: ErrorEntry = {
      type: "error",
      timestamp: Date.now(),
      message:
        "This is a very long error message that should be truncated to prevent the tree from becoming too wide and unreadable",
    };

    const item = new ErrorTreeItem(entry);
    expect((item.label as string).length).toBeLessThanOrEqual(62); // "✗ " + 57 + "..."
    expect((item.label as string).endsWith("...")).toBe(true);
  });
});

// ── ConversationItem ─────────────────────────────────────────────────

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-1",
    title: "Refactored auth middleware",
    modelId: "gpt-4o",
    status: "active",
    startTime: Date.now() - 60000,
    lastActiveTime: Date.now(),
    tokens: { input: 45000, output: 2000, maxInput: 128000 },
    turnCount: 5,
    totalOutputTokens: 8000,
    compactionEvents: [],
    activityLog: [],
    subagents: [],
    ...overrides,
  };
}

function makeUserMessage(
  sequenceNumber: number,
  extra: Partial<UserMessageEntry> = {},
): UserMessageEntry {
  return {
    type: "user-message",
    sequenceNumber,
    timestamp: Date.now() - (10 - sequenceNumber) * 1000,
    ...extra,
  };
}

function makeAIResponse(
  sequenceNumber: number,
  extra: Partial<AIResponseEntry> = {},
): AIResponseEntry {
  return {
    type: "ai-response",
    sequenceNumber,
    timestamp: Date.now() - (10 - sequenceNumber) * 1000,
    tokenContribution: 500,
    subagentIds: [],
    state: "characterized",
    ...extra,
  };
}

function makeExchange(sequenceNumber: number): ActivityLogEntry[] {
  return [makeUserMessage(sequenceNumber), makeAIResponse(sequenceNumber)];
}

function makeError(message: string, turnNumber?: number): ErrorEntry {
  return {
    type: "error",
    timestamp: Date.now(),
    message,
    ...(turnNumber != null ? { turnNumber } : {}),
  };
}

function makeCompaction(turnNumber: number): CompactionEntry {
  return {
    type: "compaction",
    timestamp: Date.now(),
    turnNumber,
    freedTokens: 10000,
    compactionType: "summarization",
  };
}

describe("ConversationItem", () => {
  it("uses conversation title as label", () => {
    const conv = makeConversation({ title: "Debug login flow" });
    const item = new ConversationItem(conv);
    expect(item.label).toBe("Debug login flow");
  });

  it("formats description with token usage and percentage", () => {
    const conv = makeConversation({
      tokens: { input: 45000, output: 2000, maxInput: 128000 },
    });
    const item = new ConversationItem(conv);
    expect(item.description).toBe("45.0k/128.0k · 35%");
  });

  it("shows streaming description when active with no tokens", () => {
    const conv = makeConversation({
      status: "active",
      tokens: { input: 0, output: 0, maxInput: 128000 },
    });
    const item = new ConversationItem(conv);
    expect(item.description).toBe("streaming...");
  });

  it("shows raw token count when maxInput is 0", () => {
    const conv = makeConversation({
      status: "idle",
      tokens: { input: 12000, output: 1000, maxInput: 0 },
    });
    const item = new ConversationItem(conv);
    expect(item.description).toBe("12.0k");
  });

  it("shows green dot for active but not streaming conversations", () => {
    const conv = makeConversation({ status: "active" });
    const item = new ConversationItem(conv);
    // Active but not streaming shows green dot (live indicator)
    expect((item.iconPath as { id: string }).id).toBe("circle-filled");
  });

  it("shows spinning icon when actively streaming", () => {
    const conv = makeConversation({
      status: "active",
      activityLog: [
        {
          type: "ai-response",
          sequenceNumber: 1,
          timestamp: Date.now(),
          state: "streaming",
          tokenContribution: 0,
          subagentIds: [],
        },
      ],
    });
    const item = new ConversationItem(conv);
    expect((item.iconPath as { id: string }).id).toBe("loading~spin");
  });

  it("shows red icon for >90% utilization", () => {
    const conv = makeConversation({
      status: "idle",
      tokens: { input: 120000, output: 2000, maxInput: 128000 },
    });
    const item = new ConversationItem(conv);
    expect(
      (item.iconPath as { id: string; color: { id: string } }).color.id,
    ).toBe("charts.red");
  });

  it("shows orange icon for >70% utilization", () => {
    const conv = makeConversation({
      status: "idle",
      tokens: { input: 100000, output: 2000, maxInput: 128000 },
    });
    const item = new ConversationItem(conv);
    expect(
      (item.iconPath as { id: string; color: { id: string } }).color.id,
    ).toBe("charts.orange");
  });

  it("shows green icon for normal utilization", () => {
    const conv = makeConversation({
      status: "idle",
      tokens: { input: 30000, output: 2000, maxInput: 128000 },
    });
    const item = new ConversationItem(conv);
    expect(
      (item.iconPath as { id: string; color: { id: string } }).color.id,
    ).toBe("charts.green");
  });

  it("is expanded by default", () => {
    const conv = makeConversation();
    const item = new ConversationItem(conv);
    expect(item.collapsibleState).toBe(2); // Expanded
  });

  it("has contextValue 'conversation'", () => {
    const conv = makeConversation();
    const item = new ConversationItem(conv);
    expect(item.contextValue).toBe("conversation");
  });

  it("generates tooltip with model, status, and token info", () => {
    const conv = makeConversation({
      turnCount: 8,
      totalOutputTokens: 12000,
    });
    const item = new ConversationItem(conv);
    const tooltip = item.tooltip as { value: string };
    expect(tooltip.value).toContain("gpt-4o");
    expect(tooltip.value).toContain("Turns");
    expect(tooltip.value).toContain("12,000");
  });
});

// ── windowActivityLog ────────────────────────────────────────────────

describe("ConversationItem.windowActivityLog", () => {
  it("returns empty array for empty log", () => {
    const result = ConversationItem.windowActivityLog([]);
    expect(result.windowed).toEqual([]);
    expect(result.hasHistory).toBe(false);
  });

  it("returns all entries when fewer than 20 non-error entries", () => {
    const log: ActivityLogEntry[] = [...makeExchange(1), ...makeExchange(2)];
    const result = ConversationItem.windowActivityLog(log);
    expect(result.windowed).toHaveLength(4);
    expect(result.hasHistory).toBe(false);
  });

  it("returns exactly 20 actual user messages when more exist", () => {
    // Create 25 exchanges (user message + AI response pairs) to exceed window of 20
    const log: ActivityLogEntry[] = Array.from({ length: 25 }, (_, i) =>
      makeExchange(i + 1),
    ).flat();
    const result = ConversationItem.windowActivityLog(log);
    // 20 user messages + 20 AI responses = 40 entries in window
    const userMessages = result.windowed.filter(
      (e) => e.type === "user-message",
    );
    expect(userMessages).toHaveLength(20);
    // Should be the 20 most recent (exchanges 6-25) in chronological order
    expect(
      userMessages.map((m) => (m).sequenceNumber),
    ).toEqual(Array.from({ length: 20 }, (_, i) => i + 6));
    expect(result.hasHistory).toBe(true);
  });

  it("includes errors alongside windowed entries without counting toward limit", () => {
    const log: ActivityLogEntry[] = [
      makeAIResponse(1),
      makeAIResponse(2),
      makeAIResponse(3),
      makeError("Failed", 3),
      makeAIResponse(4),
      makeAIResponse(5),
    ];
    const result = ConversationItem.windowActivityLog(log);
    // 5 turns + 1 error = 6 items, but the error doesn't count toward limit
    // All 5 turns fit within the window (< 20), error is within window
    expect(result.windowed).toHaveLength(6);
    expect(result.hasHistory).toBe(false);
  });

  it("ages out errors that fall outside the window", () => {
    // Create 22 exchanges + 1 error at the beginning to exceed window
    const log: ActivityLogEntry[] = [
      ...makeExchange(1),
      makeError("Old error", 1),
      ...Array.from({ length: 21 }, (_, i) => makeExchange(i + 2)).flat(),
    ];
    const result = ConversationItem.windowActivityLog(log);
    // 20 most recent user messages: 3-22. Error at turn 1 falls outside.
    const errors = result.windowed.filter((e) => e.type === "error");
    expect(errors).toHaveLength(0);
    expect(result.hasHistory).toBe(true);
  });

  it("keeps errors within the window boundary", () => {
    // Create 22 exchanges with an error in the middle (within window)
    const log: ActivityLogEntry[] = [
      ...makeExchange(1),
      ...makeExchange(2),
      ...Array.from({ length: 10 }, (_, i) => makeExchange(i + 3)).flat(),
      makeError("Recent error", 12),
      ...Array.from({ length: 10 }, (_, i) => makeExchange(i + 13)).flat(),
    ];
    const result = ConversationItem.windowActivityLog(log);
    // 20 most recent user messages: 3-22. Error at turn 12 is within.
    const errors = result.windowed.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(result.hasHistory).toBe(true);
  });

  it("handles compaction events as non-exchange entries", () => {
    // Create 21 exchanges + 1 compaction to exceed window of 20 user messages
    const log: ActivityLogEntry[] = [
      ...makeExchange(1),
      ...makeExchange(2),
      makeCompaction(2),
      ...Array.from({ length: 19 }, (_, i) => makeExchange(i + 3)).flat(),
    ];
    const result = ConversationItem.windowActivityLog(log);
    // 20 user messages + 20 AI responses + 1 compaction (doesn't count toward limit)
    // = 41 non-error entries in window
    expect(result.windowed.filter((e) => e.type !== "error")).toHaveLength(41);
    expect(result.hasHistory).toBe(true);
  });

  it("preserves chronological order in output", () => {
    const log: ActivityLogEntry[] = [
      makeAIResponse(1),
      makeAIResponse(2),
      makeError("Mid error", 2),
      makeAIResponse(3),
      makeAIResponse(4),
      makeAIResponse(5),
    ];
    const result = ConversationItem.windowActivityLog(log);
    // Verify order is chronological (oldest first)
    const turnNumbers = result.windowed
      .filter((e): e is AIResponseEntry => e.type === "ai-response")
      .map((t) => t.sequenceNumber);
    expect(turnNumbers).toEqual([...turnNumbers].sort((a, b) => a - b));
  });

  it("handles log with only errors", () => {
    const log: ActivityLogEntry[] = [
      makeError("Error 1"),
      makeError("Error 2"),
    ];
    const result = ConversationItem.windowActivityLog(log);
    expect(result.windowed).toHaveLength(2);
    expect(result.hasHistory).toBe(false);
  });
});

// ── SubagentItem ─────────────────────────────────────────────────────

function makeSubagent(overrides: Partial<Subagent> = {}): Subagent {
  return {
    conversationId: "sub-1",
    name: "recon",
    tokens: { input: 5000, output: 3000 },
    turnCount: 1,
    status: "complete",
    children: [],
    ...overrides,
  };
}

describe("SubagentItem", () => {
  it("uses subagent name as label", () => {
    const sub = makeSubagent({ name: "execute" });
    const item = new SubagentItem(sub);
    expect(item.label).toBe("execute");
  });

  it("shows token total and status in description", () => {
    const sub = makeSubagent({
      tokens: { input: 5000, output: 3000 },
      status: "complete",
    });
    const item = new SubagentItem(sub);
    expect(item.description).toBe("8.0k · complete");
  });

  it("shows streaming description for streaming subagent", () => {
    const sub = makeSubagent({ status: "streaming" });
    const item = new SubagentItem(sub);
    expect(item.description).toBe("streaming...");
    expect((item.iconPath as { id: string }).id).toBe("loading~spin");
  });

  it("shows error description for error subagent", () => {
    const sub = makeSubagent({
      tokens: { input: 2000, output: 500 },
      status: "error",
    });
    const item = new SubagentItem(sub);
    expect(item.description).toBe("2.5k · error");
    expect((item.iconPath as { id: string }).id).toBe("error");
  });

  it("shows just 'error' when no tokens", () => {
    const sub = makeSubagent({
      tokens: { input: 0, output: 0 },
      status: "error",
    });
    const item = new SubagentItem(sub);
    expect(item.description).toBe("error");
  });

  it("shows green check icon for completed subagent", () => {
    const sub = makeSubagent({ status: "complete" });
    const item = new SubagentItem(sub);
    expect((item.iconPath as { id: string }).id).toBe("check");
    expect(
      (item.iconPath as { id: string; color: { id: string } }).color.id,
    ).toBe("charts.green");
  });

  it("is collapsible when it has children", () => {
    const child = makeSubagent({
      conversationId: "sub-2",
      name: "recon-worker",
    });
    const sub = makeSubagent({ children: [child] });
    const item = new SubagentItem(sub);
    expect(item.collapsibleState).toBe(1); // Collapsed
  });

  it("is not collapsible when it has no children", () => {
    const sub = makeSubagent({ children: [] });
    const item = new SubagentItem(sub);
    expect(item.collapsibleState).toBe(0); // None
  });

  it("has contextValue 'subagent'", () => {
    const sub = makeSubagent();
    const item = new SubagentItem(sub);
    expect(item.contextValue).toBe("subagent");
  });
});

// ── resolveSubagents ─────────────────────────────────────────────────

describe("SubagentItem.resolveSubagents", () => {
  it("returns empty array for empty IDs", () => {
    const result = SubagentItem.resolveSubagents([], [makeSubagent()]);
    expect(result).toEqual([]);
  });

  it("finds subagents at top level", () => {
    const sub1 = makeSubagent({ conversationId: "sub-1", name: "recon" });
    const sub2 = makeSubagent({ conversationId: "sub-2", name: "execute" });
    const result = SubagentItem.resolveSubagents(["sub-2"], [sub1, sub2]);
    expect(result).toHaveLength(1);
    const first = result[0];
    expect(first).toBeDefined();
    expect(first?.name).toBe("execute");
  });

  it("finds nested subagents", () => {
    const nested = makeSubagent({
      conversationId: "sub-nested",
      name: "recon-worker",
    });
    const parent = makeSubagent({
      conversationId: "sub-1",
      name: "recon",
      children: [nested],
    });
    const result = SubagentItem.resolveSubagents(["sub-nested"], [parent]);
    expect(result).toHaveLength(1);
    const first = result[0];
    expect(first).toBeDefined();
    expect(first?.name).toBe("recon-worker");
  });

  it("finds multiple subagents across hierarchy", () => {
    const nested = makeSubagent({
      conversationId: "sub-nested",
      name: "worker",
    });
    const sub1 = makeSubagent({
      conversationId: "sub-1",
      name: "recon",
      children: [nested],
    });
    const sub2 = makeSubagent({ conversationId: "sub-2", name: "execute" });
    const result = SubagentItem.resolveSubagents(
      ["sub-1", "sub-nested"],
      [sub1, sub2],
    );
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.name)).toEqual(["recon", "worker"]);
  });

  it("returns empty when IDs don't match", () => {
    const sub = makeSubagent({ conversationId: "sub-1" });
    const result = SubagentItem.resolveSubagents(["nonexistent"], [sub]);
    expect(result).toEqual([]);
  });
});

// ── HistoryItem ───────────────────────────────────────────────────────

describe("HistoryItem", () => {
  it("shows plural label for multiple entries", () => {
    const entries: ActivityLogEntry[] = [
      makeAIResponse(1),
      makeAIResponse(2),
      makeAIResponse(3),
    ];
    const item = new HistoryItem(entries, "conv-1");
    expect(item.label).toBe("History (3 earlier entries)");
  });

  it("shows singular label for one entry", () => {
    const entries: ActivityLogEntry[] = [makeAIResponse(1)];
    const item = new HistoryItem(entries, "conv-1");
    expect(item.label).toBe("History (1 earlier entry)");
  });

  it("uses history icon", () => {
    const item = new HistoryItem([makeAIResponse(1)], "conv-1");
    expect((item.iconPath as { id: string }).id).toBe("history");
  });

  it("is collapsed by default", () => {
    const item = new HistoryItem([makeAIResponse(1)], "conv-1");
    expect(item.collapsibleState).toBe(1); // Collapsed
  });

  it("has contextValue 'history'", () => {
    const item = new HistoryItem([makeAIResponse(1)], "conv-1");
    expect(item.contextValue).toBe("history");
  });

  it("stores entries for provider to resolve children", () => {
    const entries: ActivityLogEntry[] = [makeAIResponse(1), makeCompaction(1)];
    const item = new HistoryItem(entries, "conv-1");
    expect(item.entries).toHaveLength(2);
    expect(item.conversationId).toBe("conv-1");
  });
});

// ── windowActivityLog with history entries ───────────────────────────

describe("ConversationItem.windowActivityLog history", () => {
  it("returns history entries for items outside window", () => {
    // Create 25 exchanges (user message + AI response) to exceed window of 20
    const log: ActivityLogEntry[] = Array.from({ length: 25 }, (_, i) =>
      makeExchange(i + 1),
    ).flat();
    const result = ConversationItem.windowActivityLog(log);
    // 20 user messages + 20 AI responses = 40 entries in window
    expect(result.windowed).toHaveLength(40);
    // 5 user messages + 5 AI responses = 10 entries in history
    expect(result.history).toHaveLength(10);
    // History should be chronological (oldest first)
    const historyUserMessages = result.history.filter(
      (e): e is UserMessageEntry => e.type === "user-message",
    );
    expect(historyUserMessages.map((t) => t.sequenceNumber)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(result.hasHistory).toBe(true);
  });

  it("history includes aged-out errors", () => {
    // Create 22 exchanges + error at beginning to exceed window of 20
    // Total: 22 exchanges (44 entries) + 1 error = 45 entries
    // Window: 20 user messages + 20 AI responses = 40 entries
    // History: 2 user messages + 2 AI responses + 1 error = 5 entries
    const log: ActivityLogEntry[] = [
      ...makeExchange(1),
      makeError("Old error", 1),
      ...Array.from({ length: 21 }, (_, i) => makeExchange(i + 2)).flat(),
    ];
    const result = ConversationItem.windowActivityLog(log);
    expect(result.history).toHaveLength(5); // exchanges 1-2 (4 entries) + error
    expect(result.history.some((e) => e.type === "error")).toBe(true);
  });

  it("empty history when all entries fit in window", () => {
    const log: ActivityLogEntry[] = makeExchange(1);
    const result = ConversationItem.windowActivityLog(log);
    expect(result.history).toHaveLength(0);
    expect(result.hasHistory).toBe(false);
  });
});

// ── SectionHeaderItem ────────────────────────────────────────────────

describe("SectionHeaderItem", () => {
  it("has label 'History'", () => {
    const item = new SectionHeaderItem([]);
    expect(item.label).toBe("History");
  });

  it("uses archive icon", () => {
    const item = new SectionHeaderItem([]);
    expect((item.iconPath as { id: string }).id).toBe("archive");
  });

  it("is collapsed by default", () => {
    const item = new SectionHeaderItem([]);
    expect(item.collapsibleState).toBe(1); // Collapsed
  });

  it("has contextValue 'sectionHeader'", () => {
    const item = new SectionHeaderItem([]);
    expect(item.contextValue).toBe("sectionHeader");
  });

  it("stores conversations for provider resolution", () => {
    const convs = [
      makeConversation({ id: "c1" }),
      makeConversation({ id: "c2" }),
    ];
    const item = new SectionHeaderItem(convs);
    expect(item.conversations).toHaveLength(2);
  });
});

describe("SectionHeaderItem.partitionConversations", () => {
  it("partitions active conversations to root", () => {
    const convs = [
      makeConversation({ id: "c1", status: "active" }),
      makeConversation({ id: "c2", status: "idle" }),
      makeConversation({ id: "c3", status: "active" }),
    ];
    const result = SectionHeaderItem.partitionConversations(convs);
    expect(result.active).toHaveLength(2);
    expect(result.history).toHaveLength(1);
    expect(result.active.map((c) => c.id)).toEqual(["c1", "c3"]);
  });

  it("puts idle and archived into history", () => {
    const convs = [
      makeConversation({ id: "c1", status: "idle" }),
      makeConversation({ id: "c2", status: "archived" }),
    ];
    const result = SectionHeaderItem.partitionConversations(convs);
    expect(result.active).toHaveLength(0);
    expect(result.history).toHaveLength(2);
  });

  it("returns empty arrays when no conversations", () => {
    const result = SectionHeaderItem.partitionConversations([]);
    expect(result.active).toEqual([]);
    expect(result.history).toEqual([]);
  });

  it("all active means empty history", () => {
    const convs = [
      makeConversation({ id: "c1", status: "active" }),
      makeConversation({ id: "c2", status: "active" }),
    ];
    const result = SectionHeaderItem.partitionConversations(convs);
    expect(result.active).toHaveLength(2);
    expect(result.history).toHaveLength(0);
  });
});
