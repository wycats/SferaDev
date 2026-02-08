import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, LanguageModelChatMessage } from "vscode";
import { TokenCache } from "./cache";
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

// Mock logger
const loggerHoisted = vi.hoisted(() => ({
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../logger", () => ({
  logger: loggerHoisted,
}));

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
    beforeEach(() => {
      loggerHoisted.debug.mockClear();
      loggerHoisted.warn.mockClear();
      loggerHoisted.info.mockClear();
    });

    it("logs deduced tokens on single message extension", () => {
      const messages1 = [createMessage(1, "hello"), createMessage(2, "world")];
      const messages2 = [...messages1, createMessage(1, "new message")];

      estimator.recordActual(messages1, testModel, 100);
      loggerHoisted.debug.mockClear();

      // Delta: 150 - 100 = 50 tokens for 1 new message
      estimator.recordActual(messages2, testModel, 150);

      expect(loggerHoisted.debug).toHaveBeenCalledWith(
        "[Estimator] Inferred tokens for message via deduction: 50 (weight=11, totalDelta=50)",
      );
    });

    it("caches deduced message tokens", () => {
      const cacheSpy = vi.spyOn(TokenCache.prototype, "cacheActual");
      const messages1 = [createMessage(1, "hello"), createMessage(2, "world")];
      const messages2 = [...messages1, createMessage(1, "new message")]; // 1 new message

      estimator.recordActual(messages1, testModel, 100);
      cacheSpy.mockClear();

      // Delta: 150 - 100 = 50 tokens for 1 new message
      estimator.recordActual(messages2, testModel, 150);

      expect(cacheSpy).toHaveBeenCalledTimes(1);
      expect(cacheSpy).toHaveBeenCalledWith(messages2[2], "claude", 50);

      cacheSpy.mockRestore();
    });

    it("distributes tokens proportionally if multiple new messages", () => {
      const cacheSpy = vi.spyOn(TokenCache.prototype, "cacheActual");
      const messages1 = [createMessage(1, "hello"), createMessage(2, "world")];
      const messages2 = [
        ...messages1,
        createMessage(1, "new1"),
        createMessage(2, "new2"),
      ]; // 2 new messages

      estimator.recordActual(messages1, testModel, 100);
      cacheSpy.mockClear();

      // Delta: 150 - 100 = 50 tokens for 2 new messages
      // Both new messages have length 4, so equal weight.
      // Should split 50 equally -> 25 each.
      estimator.recordActual(messages2, testModel, 150);

      expect(loggerHoisted.debug).toHaveBeenCalledWith(
        expect.stringContaining(
          "Inferred tokens for message via proportional distribution",
        ),
      );
      expect(cacheSpy).toHaveBeenCalledTimes(2);
      expect(cacheSpy).toHaveBeenNthCalledWith(1, messages2[2], "claude", 25);
      expect(cacheSpy).toHaveBeenNthCalledWith(2, messages2[3], "claude", 25);

      cacheSpy.mockRestore();
    });

    it("uses cached actual for new messages after deduction caching", () => {
      const messages1 = [createMessage(1, "hello"), createMessage(2, "world")];
      const messages2 = [...messages1, createMessage(1, "new message")];

      estimator.recordActual(messages1, testModel, 100);
      estimator.recordActual(messages2, testModel, 150); // dedu ction: 50

      // estimating JUST the new message should now hit cache
      const result = estimator.estimateMessage(messages2[2]!, testModel);

      expect(result).toBe(50);
    });

    it("logs warning on negative delta", () => {
      const messages1 = [createMessage(1, "hello"), createMessage(2, "world")];
      const messages2 = [...messages1, createMessage(1, "new message")];

      estimator.recordActual(messages1, testModel, 100);
      loggerHoisted.warn.mockClear();

      estimator.recordActual(messages2, testModel, 90);

      expect(loggerHoisted.warn).toHaveBeenCalledWith(
        "[Estimator] Negative delta detected: -10 tokens (actual=90, known=100)",
      );
    });

    it("does not throw when lookup includes invalid message index", () => {
      const messages = [createMessage(1, "hello")];
      const tracker = (
        estimator as unknown as {
          conversationTracker: { lookup: () => unknown };
        }
      ).conversationTracker;
      const lookupSpy = vi.spyOn(tracker, "lookup").mockReturnValue({
        type: "prefix",
        knownTokens: 100,
        newMessageIndices: [1],
        newMessageCount: 1,
      });

      expect(() =>
        estimator.recordActual(messages, testModel, 150),
      ).not.toThrow();
      expect(loggerHoisted.warn).toHaveBeenCalledWith(
        "[Estimator] Invalid message index 1 during delta caching",
      );

      lookupSpy.mockRestore();
    });

    it("skips delta computation on first turn", () => {
      const messages = [createMessage(1, "hello")];

      estimator.recordActual(messages, testModel, 100);

      expect(loggerHoisted.debug).not.toHaveBeenCalledWith(
        expect.stringContaining("Inferred tokens"),
      );
      expect(loggerHoisted.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("Negative delta detected"),
      );
    });

    it("skips delta computation on exact match", () => {
      const messages = [createMessage(1, "hello")];

      estimator.recordActual(messages, testModel, 100);
      loggerHoisted.debug.mockClear();
      loggerHoisted.warn.mockClear();

      estimator.recordActual(messages, testModel, 100);

      expect(loggerHoisted.debug).not.toHaveBeenCalledWith(
        expect.stringContaining("Inferred tokens"),
      );
      expect(loggerHoisted.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("Negative delta detected"),
      );
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
      const state = estimator.lookupConversation(messages, "claude");
      expect(state.type).toBe("none");
    });
  });
});
