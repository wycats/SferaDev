import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
  },
}));

import { CONVERSATION_TREE_STORE } from "./stores.js";

describe("CONVERSATION_TREE_STORE migration", () => {
  const migrate = CONVERSATION_TREE_STORE.migrate!;

  it("converts pending-characterization to uncharacterized on restore", () => {
    const oldData = {
      conversations: {
        "conv-1": {
          id: "conv-1",
          title: "Test",
          modelId: "model-1",
          status: "idle",
          startTime: 1000,
          lastActiveTime: 2000,
          tokens: { input: 100, output: 50 },
          turnCount: 1,
          totalOutputTokens: 50,
          activityLog: [
            {
              type: "user-message",
              sequenceNumber: 1,
              timestamp: 1000,
            },
            {
              type: "ai-response",
              sequenceNumber: 1,
              timestamp: 1500,
              state: "pending-characterization",
              tokenContribution: 50,
              subagentIds: [],
            },
          ],
          subagents: [],
        },
      },
    };

    const result = migrate(oldData, 9);
    const conv = result.conversations["conv-1"]!;
    const response = conv.activityLog.find(
      (e) => e.type === "ai-response" && e.sequenceNumber === 1,
    );
    expect(response).toMatchObject({
      type: "ai-response",
      state: "uncharacterized",
    });
  });

  it("preserves characterized entries during migration", () => {
    const oldData = {
      conversations: {
        "conv-1": {
          id: "conv-1",
          title: "Test",
          modelId: "model-1",
          status: "idle",
          startTime: 1000,
          lastActiveTime: 2000,
          tokens: { input: 100, output: 50 },
          turnCount: 1,
          totalOutputTokens: 50,
          activityLog: [
            {
              type: "ai-response",
              sequenceNumber: 1,
              timestamp: 1500,
              state: "characterized",
              characterization: "Fixed a bug",
              tokenContribution: 50,
              subagentIds: [],
            },
          ],
          subagents: [],
        },
      },
    };

    const result = migrate(oldData, 9);
    const conv = result.conversations["conv-1"]!;
    const response = conv.activityLog.find(
      (e) => e.type === "ai-response" && e.sequenceNumber === 1,
    );
    expect(response).toMatchObject({
      state: "characterized",
      characterization: "Fixed a bug",
    });
  });

  it("still converts streaming to interrupted", () => {
    const oldData = {
      conversations: {
        "conv-1": {
          id: "conv-1",
          title: "Test",
          modelId: "model-1",
          status: "idle",
          startTime: 1000,
          lastActiveTime: 2000,
          tokens: { input: 100, output: 50 },
          turnCount: 1,
          totalOutputTokens: 50,
          activityLog: [
            {
              type: "ai-response",
              sequenceNumber: 1,
              timestamp: 1500,
              state: "streaming",
              tokenContribution: 50,
              subagentIds: [],
            },
          ],
          subagents: [],
        },
      },
    };

    const result = migrate(oldData, 9);
    const conv = result.conversations["conv-1"]!;
    const response = conv.activityLog.find(
      (e) => e.type === "ai-response" && e.sequenceNumber === 1,
    );
    expect(response).toMatchObject({
      state: "interrupted",
    });
  });

  it("preserves new optional fields (responseText, toolsUsed, toolCalls)", () => {
    const oldData = {
      conversations: {
        "conv-1": {
          id: "conv-1",
          title: "Test",
          modelId: "model-1",
          status: "idle",
          startTime: 1000,
          lastActiveTime: 2000,
          tokens: { input: 100, output: 50 },
          turnCount: 1,
          totalOutputTokens: 50,
          activityLog: [
            {
              type: "ai-response",
              sequenceNumber: 1,
              timestamp: 1500,
              state: "characterized",
              characterization: "Edited files",
              tokenContribution: 50,
              subagentIds: [],
              responseText: "I fixed the bug by editing...",
              toolsUsed: ["edit_file", "read_file"],
              toolCalls: [
                {
                  callId: "call-1",
                  name: "edit_file",
                  args: { path: "foo.ts" },
                  result: "OK",
                },
              ],
            },
          ],
          subagents: [],
        },
      },
    };

    const result = migrate(oldData, 9);
    const conv = result.conversations["conv-1"]!;
    const response = conv.activityLog.find(
      (e) => e.type === "ai-response" && e.sequenceNumber === 1,
    );
    expect(response).toMatchObject({
      responseText: "I fixed the bug by editing...",
      toolsUsed: ["edit_file", "read_file"],
      toolCalls: [
        {
          callId: "call-1",
          name: "edit_file",
          args: { path: "foo.ts" },
          result: "OK",
        },
      ],
    });
  });
});
