import { beforeAll, describe, expect, it, vi } from "vitest";

const vscodeHoisted = vi.hoisted(() => {
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

vi.mock("vscode", () => vscodeHoisted);

import * as vscode from "vscode";
import { TokenCounter } from "./counter";
import { STATEFUL_MARKER_MIME } from "../utils/stateful-marker";

beforeAll(async () => {
  const counter = new TokenCounter();
  await counter.initialize();
}, 30_000);

describe("TokenCounter", () => {
  it("uses claude encoding for Anthropic models", () => {
    const counter = new TokenCounter();
    const tokens = counter.estimateTextTokens(
      "hello world",
      "claude-3-5-sonnet",
    );
    // ai-tokenizer's claude encoding should produce a reasonable count
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });

  it("uses o200k_base for OpenAI models", () => {
    const counter = new TokenCounter();
    const tokens = counter.estimateTextTokens("hello world", "gpt-4o");
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });

  it("uses o200k_base for non-Anthropic models (gemini, llama, etc.)", () => {
    const counter = new TokenCounter();

    const geminiTokens = counter.estimateTextTokens(
      "hello world",
      "gemini-2.0-flash",
    );
    const llamaTokens = counter.estimateTextTokens(
      "hello world",
      "llama-3.1-70b",
    );

    expect(geminiTokens).toBeGreaterThan(0);
    expect(llamaTokens).toBeGreaterThan(0);
  });

  it("treats Claude family names case-insensitively", () => {
    const counter = new TokenCounter();
    const lower = counter.estimateTextTokens("test input", "claude-3-5-sonnet");
    const upper = counter.estimateTextTokens("test input", "Claude-3-5-Sonnet");
    expect(lower).toBe(upper);
  });

  it("ignores stateful marker data parts", () => {
    const counter = new TokenCounter();
    const message = {
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [
        new vscode.LanguageModelDataPart(
          new Uint8Array([1, 2, 3]),
          STATEFUL_MARKER_MIME,
        ),
      ],
    } as vscode.LanguageModelChatMessage;

    // Only MESSAGE_OVERHEAD (3) should be counted, no content tokens
    const tokens = counter.estimateMessageTokens(message, "gpt-4o");
    expect(tokens).toBe(3); // MESSAGE_OVERHEAD only
  });

  it("ignores thinking data parts", () => {
    const counter = new TokenCounter();
    const thinkingContent = new TextEncoder().encode(
      "Let me think about this step by step...",
    );
    const message = {
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [new vscode.LanguageModelDataPart(thinkingContent, "thinking")],
    } as vscode.LanguageModelChatMessage;

    // Only MESSAGE_OVERHEAD (3) should be counted, thinking content excluded
    const tokens = counter.estimateMessageTokens(message, "claude-sonnet-4");
    expect(tokens).toBe(3); // MESSAGE_OVERHEAD only
  });

  it("mixed content: text counted, thinking+stateful_marker excluded", () => {
    const counter = new TokenCounter();
    const textContent = "Hello, this is visible text content.";
    const thinkingContent = new TextEncoder().encode(
      "Internal reasoning that should not be counted...",
    );
    const markerContent = new Uint8Array([1, 2, 3]);

    const message = {
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [
        new vscode.LanguageModelTextPart(textContent),
        new vscode.LanguageModelDataPart(thinkingContent, "thinking"),
        new vscode.LanguageModelDataPart(markerContent, STATEFUL_MARKER_MIME),
      ],
    } as vscode.LanguageModelChatMessage;

    // Only text tokens + MESSAGE_OVERHEAD should be counted
    const textOnlyTokens = counter.estimateTextTokens(textContent, "gpt-4o");
    const totalTokens = counter.estimateMessageTokens(message, "gpt-4o");

    // Total = text tokens + overhead, metadata DataParts excluded
    expect(totalTokens).toBe(textOnlyTokens + 3); // 3 = MESSAGE_OVERHEAD
    // Verify the metadata didn't add tokens (thinking content is ~10 tokens)
    expect(totalTokens).toBeLessThan(textOnlyTokens + 10);
  });

  it("adds per-message overhead", () => {
    const counter = new TokenCounter();
    const emptyMessage = {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [],
    } as unknown as vscode.LanguageModelChatMessage;

    const tokens = counter.estimateMessageTokens(emptyMessage, "gpt-4o");
    expect(tokens).toBe(3); // MESSAGE_OVERHEAD
  });

  it("estimates message tokens with text parts", () => {
    const counter = new TokenCounter();
    const message = {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [new vscode.LanguageModelTextPart("Hello, world!")],
    } as vscode.LanguageModelChatMessage;

    const result = counter.estimateMessageTokens(message, "gpt-4o");
    // Should be text tokens + MESSAGE_OVERHEAD (3)
    expect(result).toBeGreaterThan(3);
  });

  it("caches text tokenization results", () => {
    const counter = new TokenCounter();

    const first = counter.estimateTextTokens("hello world test", "gpt-4o");
    const second = counter.estimateTextTokens("hello world test", "gpt-4o");

    expect(first).toBe(second);
  });

  it("uses separate cache entries per encoding", () => {
    const counter = new TokenCounter();

    const openai = counter.estimateTextTokens("hello world test", "gpt-4o");
    const anthropic = counter.estimateTextTokens(
      "hello world test",
      "claude-3-5-sonnet",
    );

    // Both should produce a count, values may differ between encodings
    expect(openai).toBeGreaterThan(0);
    expect(anthropic).toBeGreaterThan(0);
  });

  it("returns 0 for empty text", () => {
    const counter = new TokenCounter();
    expect(counter.estimateTextTokens("", "gpt-4o")).toBe(0);
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

  it("produces positive token count for tools with schemas", () => {
    const counter = new TokenCounter();
    const tools = [
      {
        name: "readFile",
        description: "Read a file from disk",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
      {
        name: "writeFile",
        description: "Write content to a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
        },
      },
    ];

    const result = counter.countToolsTokens(tools, "gpt-4o");
    // Base: 16, per-tool: 8 × 2 = 16, plus content tokens × 1.1
    expect(result).toBeGreaterThan(32);
  });

  it("uses higher multiplier for Anthropic models", () => {
    const counter = new TokenCounter();
    const tools = [
      {
        name: "search",
        description: "Search the codebase",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    ];

    const openai = counter.countToolsTokens(tools, "gpt-4o");
    const anthropic = counter.countToolsTokens(tools, "claude-3-5-sonnet");

    // Anthropic uses 1.4 multiplier vs 1.1 for OpenAI
    expect(anthropic).toBeGreaterThan(openai);
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

  it("adds 28 token overhead for system prompt", () => {
    const counter = new TokenCounter();
    const systemPrompt = "You are a helpful assistant.";

    const textTokens = counter.estimateTextTokens(systemPrompt, "gpt-4o");
    const systemTokens = counter.countSystemPromptTokens(
      systemPrompt,
      "gpt-4o",
    );

    expect(systemTokens).toBe(textTokens + 28);
  });
});
