import { describe, expect, it, vi } from "vitest";

// Create hoisted mock for vscode module
const hoisted = vi.hoisted(() => {
  class MockLanguageModelChatMessage {
    role: number;
    content: unknown[];
    name: string | undefined;
    constructor(role: number, content: string | unknown[], name?: string) {
      this.role = role;
      this.content =
        typeof content === "string" ? [{ value: content }] : content;
      this.name = name;
    }
    static User(
      content: string | unknown[],
      name?: string,
    ): MockLanguageModelChatMessage {
      return new MockLanguageModelChatMessage(1, content, name);
    }
  }

  const MockLanguageModelChatMessageRole = {
    User: 1,
    Assistant: 2,
  };

  const MockLanguageModelChatToolMode = {
    Auto: 1,
    Required: 2,
  };

  return {
    MockLanguageModelChatMessage,
    MockLanguageModelChatMessageRole,
    MockLanguageModelChatToolMode,
  };
});

// Mock vscode module
vi.mock("vscode", () => ({
  LanguageModelChatMessage: hoisted.MockLanguageModelChatMessage,
  LanguageModelChatMessageRole: hoisted.MockLanguageModelChatMessageRole,
  LanguageModelChatToolMode: hoisted.MockLanguageModelChatToolMode,
}));

// Mock logger
vi.mock("../logger.js", () => ({
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock system prompt extraction
vi.mock("./system-prompt.js", () => ({
  extractSystemPrompt: vi.fn(() => undefined),
}));

import { LanguageModelChatToolMode } from "vscode";
import { translateRequest } from "./request-builder.js";

describe("translateRequest tool structure", () => {
  it("should keep tool name and parameters at top level (flat structure)", () => {
    // Regression guard: prevent OpenAI Chat Completions tool format creep.
    const options = {
      tools: [
        {
          name: "get_time",
          description: "Get the current time",
          inputSchema: {
            type: "object",
            properties: { timezone: { type: "string" } },
          },
        },
      ],
      toolMode: LanguageModelChatToolMode.Auto,
    };

    const configService = {
      systemPromptEnabled: false,
      systemPromptMessage: "",
    };

    const result = translateRequest([], options, configService as never);

    expect(result.tools).toHaveLength(1);
    const tool = result.tools[0]!;
    expect(tool.name).toBe("get_time");
    expect(tool.parameters).toEqual({
      type: "object",
      properties: { timezone: { type: "string" } },
    });
    expect("function" in tool).toBe(false);
  });
});
