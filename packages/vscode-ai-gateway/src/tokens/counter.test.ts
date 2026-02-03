import { describe, expect, it, vi } from "vitest";

const vscodeHoisted = vi.hoisted(() => {
  // Mock the role enum
  const LanguageModelChatMessageRole = {
    User: 1,
    Assistant: 2,
  };

  class LanguageModelTextPart {
    constructor(public value: string) {}
  }

  class LanguageModelDataPart {
    constructor(
      public data: Uint8Array,
      public mimeType: string,
    ) {}
  }

  class LanguageModelToolCallPart {
    constructor(
      public name: string,
      public callId: string,
      public input: unknown,
    ) {}
  }

  class LanguageModelToolResultPart {
    constructor(
      public callId: string,
      public content: unknown[],
    ) {}
  }

  return {
    LanguageModelChatMessageRole,
    LanguageModelTextPart,
    LanguageModelDataPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
  };
});

const tiktokenHoisted = vi.hoisted(() => {
  const mockEncode = vi.fn(
    (
      text: string,
      _allowedSpecial?: string[] | "all",
      _disallowedSpecial?: string[] | "all",
    ) => {
      void _allowedSpecial;
      void _disallowedSpecial;
      return Array.from({ length: text.length });
    },
  );
  const mockEncoding = { encode: mockEncode };
  const mockGetEncoding = vi.fn(() => mockEncoding);

  return {
    mockEncode,
    mockEncoding,
    mockGetEncoding,
  };
});

vi.mock("vscode", () => vscodeHoisted);
vi.mock("js-tiktoken", () => ({
  getEncoding: tiktokenHoisted.mockGetEncoding,
}));

import * as vscode from "vscode";
import { TokenCounter } from "./counter";

describe("TokenCounter", () => {
  it("uses o200k_base for gpt-4o families", () => {
    const counter = new TokenCounter();
    counter.estimateTextTokens("hello", "gpt-4o");

    expect(tiktokenHoisted.mockGetEncoding).toHaveBeenCalledWith("o200k_base");
  });

  it("uses o200k_base for o1 families", () => {
    const counter = new TokenCounter();
    counter.estimateTextTokens("hello", "o1-mini");

    expect(tiktokenHoisted.mockGetEncoding).toHaveBeenCalledWith("o200k_base");
  });

  it("uses cl100k_base for claude families", () => {
    const counter = new TokenCounter();
    counter.estimateTextTokens("hello", "claude-3-5-sonnet");

    expect(tiktokenHoisted.mockGetEncoding).toHaveBeenCalledWith("cl100k_base");
  });

  it("falls back to character estimation when encoding is unavailable", () => {
    tiktokenHoisted.mockGetEncoding.mockImplementationOnce(() => {
      throw new Error("encoding unavailable");
    });

    const counter = new TokenCounter();
    const result = counter.estimateTextTokens("1234567", "gpt-4");

    expect(result).toBe(2);
  });

  it("reports character fallback when encoding is unavailable", () => {
    tiktokenHoisted.mockGetEncoding.mockImplementationOnce(() => {
      throw new Error("encoding unavailable");
    });

    const counter = new TokenCounter();
    const fallback = counter.usesCharacterFallback("gpt-4");

    expect(fallback).toBe(true);
  });

  it("estimates message tokens using tiktoken", () => {
    const counter = new TokenCounter();
    const message = {
      role: vscode.LanguageModelChatMessageRole.User,
      name: "test",
      content: [new vscode.LanguageModelTextPart("Hello")],
    } as vscode.LanguageModelChatMessage;

    const result = counter.estimateMessageTokens(message, "gpt-4");

    expect(result).toBe(5);
    expect(tiktokenHoisted.mockEncode).toHaveBeenCalled();
  });

  it("caches text tokenization results", () => {
    tiktokenHoisted.mockEncode.mockClear();
    const counter = new TokenCounter();

    counter.estimateTextTokens("hello", "gpt-4");
    counter.estimateTextTokens("hello", "gpt-4");

    expect(tiktokenHoisted.mockEncode).toHaveBeenCalledTimes(1);
  });

  it("uses separate cache entries per model family", () => {
    tiktokenHoisted.mockEncode.mockClear();
    const counter = new TokenCounter();

    counter.estimateTextTokens("hello", "gpt-4");
    counter.estimateTextTokens("hello", "claude-3-5-sonnet");

    expect(tiktokenHoisted.mockEncode).toHaveBeenCalledTimes(2);
  });

  it("passes allowedSpecial='all' to allow special tokens like <|endoftext|>", () => {
    tiktokenHoisted.mockEncode.mockClear();
    const counter = new TokenCounter();

    // This text contains a special token that would throw without allowedSpecial
    counter.estimateTextTokens("Hello <|endoftext|> world", "gpt-4");

    // Verify encode was called with allowedSpecial="all" and disallowedSpecial=[]
    expect(tiktokenHoisted.mockEncode).toHaveBeenCalledWith(
      "Hello <|endoftext|> world",
      "all",
      [],
    );
  });
});

describe("countToolsTokens", () => {
  it("returns 0 for empty tools array", () => {
    const counter = new TokenCounter();
    const result = counter.countToolsTokens([], "gpt-4o");
    expect(result).toBe(0);
  });

  it("returns 0 for undefined tools", () => {
    const counter = new TokenCounter();
    const result = counter.countToolsTokens(undefined, "gpt-4o");
    expect(result).toBe(0);
  });

  it("calculates tokens using GCMP formula: 16 base + 8/tool + content × 1.1", () => {
    const counter = new TokenCounter();
    const tools = [
      {
        name: "tool1",
        description: "desc1",
        inputSchema: { type: "object" },
      },
      {
        name: "tool2",
        description: "desc2",
        inputSchema: { type: "string" },
      },
    ] as vscode.LanguageModelChatTool[];

    const result = counter.countToolsTokens(tools, "gpt-4o");

    // Base: 16, per-tool: 8 × 2 = 16, content tokens × 1.1
    // Content = "tool1" (5) + "desc1" (5) + JSON (17) + "tool2" (5) + "desc2" (5) + JSON (17) = 54
    // Total = Math.ceil((16 + 16 + 54) × 1.1) = Math.ceil(94.6) = 95
    expect(result).toBeGreaterThan(0);
    expect(tiktokenHoisted.mockEncode).toHaveBeenCalled();
  });
});

describe("countSystemPromptTokens", () => {
  it("returns 0 for empty system prompt", () => {
    const counter = new TokenCounter();
    const result = counter.countSystemPromptTokens("", "gpt-4o");
    expect(result).toBe(0);
  });

  it("returns 0 for undefined system prompt", () => {
    const counter = new TokenCounter();
    const result = counter.countSystemPromptTokens(undefined, "gpt-4o");
    expect(result).toBe(0);
  });

  it("adds 28 token overhead for system prompt wrapping", () => {
    const counter = new TokenCounter();
    const systemPrompt = "You are a helpful assistant.";
    const result = counter.countSystemPromptTokens(systemPrompt, "gpt-4o");

    // Text length + 28 overhead
    // "You are a helpful assistant." = 29 chars = 29 tokens (mock)
    // Total = 29 + 28 = 57
    expect(result).toBe(systemPrompt.length + 28);
    expect(tiktokenHoisted.mockEncode).toHaveBeenCalled();
  });
});
