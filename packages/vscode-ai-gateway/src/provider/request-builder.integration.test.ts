import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  class MockLanguageModelTextPart {
    value: string;
    constructor(value: string) {
      this.value = value;
    }
  }

  class MockLanguageModelDataPart {
    data: Uint8Array;
    mimeType: string;
    constructor(data: Uint8Array, mimeType: string) {
      this.data = data;
      this.mimeType = mimeType;
    }
  }

  class MockLanguageModelToolCallPart {
    callId: string;
    name: string;
    input: unknown;
    constructor(callId: string, name: string, input: unknown) {
      this.callId = callId;
      this.name = name;
      this.input = input;
    }
  }

  class MockLanguageModelToolResultPart {
    callId: string;
    content: unknown;
    constructor(callId: string, content: unknown) {
      this.callId = callId;
      this.content = content;
    }
  }

  class MockLanguageModelChatMessage {
    role: number;
    content: unknown[];
    name: string | undefined;
    constructor(role: number, content: string | unknown[], name?: string) {
      this.role = role;
      this.content =
        typeof content === "string"
          ? [new MockLanguageModelTextPart(content)]
          : content;
      this.name = name;
    }
  }

  const MockLanguageModelChatMessageRole = {
    User: 1,
    Assistant: 2,
    System: 3,
  };

  const MockLanguageModelChatToolMode = {
    Auto: 1,
    Required: 2,
  };

  return {
    MockLanguageModelChatMessage,
    MockLanguageModelChatMessageRole,
    MockLanguageModelChatToolMode,
    MockLanguageModelTextPart,
    MockLanguageModelDataPart,
    MockLanguageModelToolCallPart,
    MockLanguageModelToolResultPart,
  };
});

vi.mock("vscode", () => ({
  LanguageModelChatMessage: hoisted.MockLanguageModelChatMessage,
  LanguageModelChatMessageRole: hoisted.MockLanguageModelChatMessageRole,
  LanguageModelChatToolMode: hoisted.MockLanguageModelChatToolMode,
  LanguageModelTextPart: hoisted.MockLanguageModelTextPart,
  LanguageModelDataPart: hoisted.MockLanguageModelDataPart,
  LanguageModelToolCallPart: hoisted.MockLanguageModelToolCallPart,
  LanguageModelToolResultPart: hoisted.MockLanguageModelToolResultPart,
}));

vi.mock("../logger.js", () => ({
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { LanguageModelChatToolMode } from "vscode";
import { translateRequest } from "./request-builder.js";

describe("translateRequest system prompt extraction (integration)", () => {
  it("maps System role message to instructions and removes it from input", () => {
    const systemText = "System prompt: follow rules";
    const userText = "Hello";

    const messages = [
      new hoisted.MockLanguageModelChatMessage(3, systemText),
      new hoisted.MockLanguageModelChatMessage(1, userText),
    ];

    const options = { tools: [], toolMode: LanguageModelChatToolMode.Auto };
    const configService = {
      systemPromptEnabled: false,
      systemPromptMessage: "",
    };

    const result = translateRequest(messages, options, configService);

    expect(result.instructions).toBe(systemText);
    expect(JSON.stringify(result.input)).not.toContain(systemText);
  });

  it("removes the System message so only user/assistant remain", () => {
    const systemText = "System prompt: keep it safe";
    const userText = "User question";
    const assistantText = "Assistant reply";

    const messages = [
      new hoisted.MockLanguageModelChatMessage(3, systemText),
      new hoisted.MockLanguageModelChatMessage(1, userText),
      new hoisted.MockLanguageModelChatMessage(2, assistantText),
    ];

    const options = { tools: [], toolMode: LanguageModelChatToolMode.Auto };
    const configService = {
      systemPromptEnabled: false,
      systemPromptMessage: "",
    };

    const result = translateRequest(messages, options, configService);

    const messageItems = result.input.filter(
      (item) => item.type === "message",
    ) as { role: string; content: string }[];

    expect(messageItems).toHaveLength(2);
    expect(messageItems.map((item) => item.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(messageItems.map((item) => item.content)).toEqual([
      userText,
      assistantText,
    ]);
  });

  it("returns undefined instructions when no System role message exists", () => {
    const userText = "Just a user message";

    const messages = [new hoisted.MockLanguageModelChatMessage(1, userText)];
    const options = { tools: [], toolMode: LanguageModelChatToolMode.Auto };
    const configService = {
      systemPromptEnabled: false,
      systemPromptMessage: "",
    };

    const result = translateRequest(messages, options, configService);

    expect(result.instructions).toBeUndefined();
  });
});
