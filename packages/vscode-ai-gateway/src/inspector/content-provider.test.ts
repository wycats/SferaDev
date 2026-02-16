import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  Uri: {
    parse: (s: string) => {
      const url = new URL(s);
      return {
        scheme: url.protocol.slice(0, -1),
        authority: url.hostname,
        path: url.pathname,
        query: url.search,
        toString: () => s,
      };
    },
  },
  EventEmitter: class {
    event = () => ({ dispose: vi.fn() });
    fire = vi.fn();
    dispose = vi.fn();
  },
}));

import type {
  ActivityLogEntry,
  Conversation,
  TurnEntry,
} from "../conversation/types.js";
import {
  InspectorContentProvider,
  parseInspectorUri,
} from "./content-provider.js";
import { inspectorUri } from "./uri.js";
import { renderTurn } from "./render.js";

function makeConversation(): Conversation {
  const activityLog: ActivityLogEntry[] = [
    {
      type: "user-message",
      sequenceNumber: 1,
      timestamp: 1100,
      preview: "Hello",
      tokenContribution: 120,
    },
    {
      type: "ai-response",
      sequenceNumber: 1,
      timestamp: 1200,
      state: "characterized",
      characterization: "Replied",
      tokenContribution: 200,
      subagentIds: ["sub-1"],
      toolsUsed: ["read_file"],
    },
    {
      type: "user-message",
      sequenceNumber: 1,
      timestamp: 1300,
      isToolContinuation: true,
      tokenContribution: 50,
    },
    {
      type: "compaction",
      timestamp: 1400,
      turnNumber: 1,
      freedTokens: 1000,
      compactionType: "summarization",
      details: "Condensed context",
    },
    {
      type: "error",
      timestamp: 1500,
      turnNumber: 1,
      message: "Something went wrong",
    },
  ];

  return {
    id: "conv-1",
    title: "Test Conversation",
    firstMessagePreview: "Hello",
    modelId: "test-model",
    status: "active",
    startTime: 1000,
    lastActiveTime: 2000,
    tokens: { input: 2000, output: 500, maxInput: 8000 },
    turnCount: 1,
    totalOutputTokens: 700,
    compactionEvents: [],
    activityLog,
    subagents: [
      {
        conversationId: "sub-1",
        name: "recon",
        tokens: { input: 100, output: 50 },
        turnCount: 1,
        status: "complete",
        children: [],
      },
    ],
    workspaceFolder: "/workspace",
  };
}

describe("parseInspectorUri", () => {
  it("parses full inspector URI", () => {
    const uri = inspectorUri("conv-1", "user-message", 2);
    expect(parseInspectorUri(uri)).toEqual({
      conversationId: "conv-1",
      entryType: "user-message",
      identifier: "2",
    });
  });

  it("parses URIs without an identifier", () => {
    const uri = inspectorUri("conv-1", "conversation");
    expect(parseInspectorUri(uri)).toEqual({
      conversationId: "conv-1",
      entryType: "conversation",
    });
  });
});

describe("InspectorContentProvider", () => {
  it("renders content for each entry type", () => {
    const conversation = makeConversation();
    const provider = new InspectorContentProvider(() => [conversation]);

    const user = provider.provideTextDocumentContent(
      inspectorUri("conv-1", "user-message", 1),
    );
    expect(user).toContain("User Message");
    expect(user).toContain("sequenceNumber");

    const toolContinuation = provider.provideTextDocumentContent(
      inspectorUri("conv-1", "tool-continuation", 1),
    );
    expect(toolContinuation).toContain("Tool Continuation");
    expect(toolContinuation).toContain("tools");

    const response = provider.provideTextDocumentContent(
      inspectorUri("conv-1", "ai-response", 1),
    );
    expect(response).toContain("AI Response");
    expect(response).toContain("characterization");

    const compaction = provider.provideTextDocumentContent(
      inspectorUri("conv-1", "compaction", 1),
    );
    expect(compaction).toContain("Compaction");
    expect(compaction).toContain("freedTokens");

    const error = provider.provideTextDocumentContent(
      inspectorUri("conv-1", "error", 1),
    );
    expect(error).toContain("Error");
    expect(error).toContain("message");

    const subagent = provider.provideTextDocumentContent(
      inspectorUri("conv-1", "subagent", "sub-1"),
    );
    expect(subagent).toContain("Subagent");
    expect(subagent).toContain("conversationId");

    const conversationDoc = provider.provideTextDocumentContent(
      inspectorUri("conv-1", "conversation"),
    );
    expect(conversationDoc).toContain("Conversation");
    expect(conversationDoc).toContain("Activity Log Summary");

    const history = provider.provideTextDocumentContent(
      inspectorUri("conv-1", "history"),
    );
    expect(history).toContain("History");
    expect(history).toContain("Summary");
  });

  it("returns Not found for missing conversations or entries", () => {
    const provider = new InspectorContentProvider(() => []);
    const missingConversation = provider.provideTextDocumentContent(
      inspectorUri("missing", "conversation"),
    );
    expect(missingConversation).toBe("Not found");

    const providerWithData = new InspectorContentProvider(() => [
      makeConversation(),
    ]);
    const missingEntry = providerWithData.provideTextDocumentContent(
      inspectorUri("conv-1", "ai-response", 99),
    );
    expect(missingEntry).toBe("Not found");
  });

  it("refreshes all open URIs", () => {
    const provider = new InspectorContentProvider(() => [makeConversation()]);
    provider.provideTextDocumentContent(inspectorUri("conv-1", "conversation"));
    provider.provideTextDocumentContent(
      inspectorUri("conv-1", "user-message", 1),
    );

    const emitter = (
      provider as unknown as {
        _onDidChange: { fire: ReturnType<typeof vi.fn> };
      }
    )._onDidChange;

    provider.refresh();

    expect(emitter.fire).toHaveBeenCalledTimes(2);
  });
});

describe("renderTurn", () => {
  it("renders turn details", () => {
    const turn: TurnEntry = {
      type: "turn",
      turnNumber: 3,
      timestamp: 3000,
      characterization: "Did the thing",
      outputTokens: 800,
      subagentIds: ["sub-1"],
      streaming: false,
    };

    const conversation = makeConversation();
    const content = renderTurn(turn, conversation);
    expect(content).toContain("Turn 3");
    expect(content).toContain("outputTokens");
  });
});
