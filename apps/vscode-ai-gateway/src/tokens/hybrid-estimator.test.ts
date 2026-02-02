import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, LanguageModelChatMessage } from "vscode";
import { HybridTokenEstimator, type ModelInfo } from "./hybrid-estimator";

// Mock vscode module
const vscodeHoisted = vi.hoisted(() => {
  const LanguageModelChatMessageRole = {
    User: 1,
    Assistant: 2,
  };

  class LanguageModelTextPart {
    constructor(public value: string) {}
  }

  return {
    LanguageModelChatMessageRole,
    LanguageModelTextPart,
  };
});

vi.mock("vscode", () => vscodeHoisted);

// Mock tiktoken
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

vi.mock("js-tiktoken", () => ({
  getEncoding: tiktokenHoisted.mockGetEncoding,
}));

// Helper to create mock messages
function createMessage(
  role: number,
  content: string,
): LanguageModelChatMessage {
  return {
    role,
    content: [new vscodeHoisted.LanguageModelTextPart(content)],
  } as unknown as LanguageModelChatMessage;
}

describe("HybridTokenEstimator", () => {
  let estimator: HybridTokenEstimator;
  let mockContext: ExtensionContext;

  const testModel: ModelInfo = {
    family: "claude",
    maxInputTokens: 100000,
  };

  beforeEach(() => {
    mockContext = {
      globalState: {
        get: vi.fn(),
        update: vi.fn(() => Promise.resolve()),
      },
    } as unknown as ExtensionContext;

    estimator = new HybridTokenEstimator(mockContext);
  });

  describe("estimateMessage", () => {
    it("returns tiktoken estimate for a string", () => {
      const result = estimator.estimateMessage("hello world", testModel);

      // "hello world" = 11 chars = 11 tokens (mock)
      expect(result).toBe(11);
    });

    it("returns tiktoken estimate for a message", () => {
      const message = createMessage(1, "hello world");
      const result = estimator.estimateMessage(message, testModel);

      // "hello world" = 11 chars = 11 tokens (mock)
      expect(result).toBe(11);
    });

    it("tracks calls in sequence", () => {
      estimator.estimateMessage("hello", testModel);
      estimator.estimateMessage("world", testModel);

      const sequence = estimator.getCurrentSequence();
      expect(sequence?.calls).toHaveLength(2);
    });
  });

  describe("estimateConversation", () => {
    it("returns full estimate when no known state", () => {
      const messages = [createMessage(1, "hello"), createMessage(2, "world")];

      const result = estimator.estimateConversation(messages, testModel);

      expect(result.source).toBe("estimated");
      expect(result.knownTokens).toBe(0);
      expect(result.newMessageCount).toBe(2);
      // 5 + 5 = 10 char tokens + 2*4 = 8 message overhead = 18
      expect(result.tokens).toBe(18);
    });

    it("returns exact match after recording actual", () => {
      const messages = [createMessage(1, "hello"), createMessage(2, "world")];

      // Record actual from API
      estimator.recordActual(messages, testModel, 500);

      // Same messages should return exact match
      const result = estimator.estimateConversation(messages, testModel);

      expect(result.source).toBe("exact");
      expect(result.tokens).toBe(500);
      expect(result.knownTokens).toBe(500);
      expect(result.estimatedTokens).toBe(0);
      expect(result.newMessageCount).toBe(0);
    });

    it("returns delta estimate when conversation extends known state", () => {
      const messages1 = [createMessage(1, "hello"), createMessage(2, "world")];

      // Record actual from API
      estimator.recordActual(messages1, testModel, 500);

      // Add a new message
      const messages2 = [...messages1, createMessage(1, "new message")];

      const result = estimator.estimateConversation(messages2, testModel);

      expect(result.source).toBe("delta");
      expect(result.knownTokens).toBe(500);
      // "new message" = 11 chars + 4 overhead = 15
      expect(result.estimatedTokens).toBe(15);
      expect(result.tokens).toBe(515);
      expect(result.newMessageCount).toBe(1);
    });

    it("returns full estimate when conversation diverges", () => {
      const messages1 = [createMessage(1, "hello"), createMessage(2, "world")];

      // Record actual from API
      estimator.recordActual(messages1, testModel, 500);

      // Different conversation (not a prefix)
      const messages2 = [
        createMessage(1, "different"),
        createMessage(2, "conversation"),
      ];

      const result = estimator.estimateConversation(messages2, testModel);

      expect(result.source).toBe("estimated");
      expect(result.knownTokens).toBe(0);
      expect(result.newMessageCount).toBe(2);
    });
  });

  describe("recordActual", () => {
    it("stores known state for model family", () => {
      const messages = [createMessage(1, "hello"), createMessage(2, "world")];

      estimator.recordActual(messages, testModel, 500);

      const state = estimator.getConversationState("claude");
      expect(state?.actualTokens).toBe(500);
      expect(state?.messageHashes).toHaveLength(2);
    });

    it("overwrites previous state for same model family", () => {
      const messages1 = [createMessage(1, "first")];
      const messages2 = [createMessage(1, "second")];

      estimator.recordActual(messages1, testModel, 100);
      estimator.recordActual(messages2, testModel, 200);

      const state = estimator.getConversationState("claude");
      expect(state?.actualTokens).toBe(200);
    });
  });

  describe("lookupConversation", () => {
    it("returns none when no state exists", () => {
      const messages = [createMessage(1, "hello")];

      const result = estimator.lookupConversation(messages, "claude");

      expect(result.type).toBe("none");
    });

    it("returns exact when messages match", () => {
      const messages = [createMessage(1, "hello")];

      estimator.recordActual(messages, testModel, 100);

      const result = estimator.lookupConversation(messages, "claude");

      expect(result.type).toBe("exact");
      expect(result.knownTokens).toBe(100);
    });

    it("returns prefix when conversation extends", () => {
      const messages1 = [createMessage(1, "hello")];

      estimator.recordActual(messages1, testModel, 100);

      const messages2 = [...messages1, createMessage(2, "world")];

      const result = estimator.lookupConversation(messages2, "claude");

      expect(result.type).toBe("prefix");
      expect(result.knownTokens).toBe(100);
      expect(result.newMessageCount).toBe(1);
      expect(result.newMessageIndices).toEqual([1]);
    });
  });

  describe("reset", () => {
    it("clears sequence and conversation state", () => {
      const messages = [createMessage(1, "hello")];

      estimator.estimateMessage("test", testModel);
      estimator.recordActual(messages, testModel, 100);

      estimator.reset();

      expect(estimator.getCurrentSequence()).toBeNull();
      expect(estimator.getConversationState("claude")).toBeUndefined();
    });
  });
});
