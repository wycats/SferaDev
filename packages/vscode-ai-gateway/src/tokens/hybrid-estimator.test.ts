import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

    it("logs delta caching opportunity on prefix match", () => {
      const messages1 = [createMessage(1, "hello"), createMessage(2, "world")];
      const messages2 = [...messages1, createMessage(1, "new message")];

      estimator.recordActual(messages1, testModel, 100);
      loggerHoisted.debug.mockClear();

      estimator.recordActual(messages2, testModel, 150);

      expect(loggerHoisted.debug).toHaveBeenCalledWith(
        "[Estimator] Delta caching opportunity: 50 tokens / 1 messages = 50 per message",
      );
    });

    it("caches per-message tokens for new messages on prefix match", () => {
      const cacheSpy = vi.spyOn(TokenCache.prototype, "cacheActual");
      const messages1 = [createMessage(1, "hello"), createMessage(2, "world")];
      const messages2 = [
        ...messages1,
        createMessage(1, "new message"),
        createMessage(2, "another one"),
      ];

      estimator.recordActual(messages1, testModel, 100);
      cacheSpy.mockClear();

      estimator.recordActual(messages2, testModel, 160);

      expect(cacheSpy).toHaveBeenCalledTimes(2);
      expect(cacheSpy).toHaveBeenNthCalledWith(1, messages2[2], "claude", 30);
      expect(cacheSpy).toHaveBeenNthCalledWith(2, messages2[3], "claude", 30);

      cacheSpy.mockRestore();
    });

    it("uses cached actual for new messages after delta caching", () => {
      const messages1 = [createMessage(1, "hello"), createMessage(2, "world")];
      const messages2 = [...messages1, createMessage(1, "new message")];

      estimator.recordActual(messages1, testModel, 100);
      estimator.recordActual(messages2, testModel, 160);

      const result = estimator.estimateMessage(messages2[2]!, testModel);

      expect(result).toBe(60);
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
        expect.stringContaining("Delta caching opportunity"),
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
        expect.stringContaining("Delta caching opportunity"),
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

  describe("getAdjustment", () => {
    it("returns 0 when no prior state exists", () => {
      expect(estimator.getAdjustment("claude")).toBe(0);
    });

    it("returns 0 when no sequenceEstimate was recorded", () => {
      const messages = [createMessage(1, "hello")];
      estimator.recordActual(messages, testModel, 500);

      expect(estimator.getAdjustment("claude")).toBe(0);
    });

    it("returns positive difference when actual exceeds estimate", () => {
      const messages = [createMessage(1, "hello")];
      // sequenceEstimate=400, actualTokens=500 → adjustment=100
      estimator.recordActual(messages, testModel, 500, 400);

      expect(estimator.getAdjustment("claude")).toBe(100);
    });

    it("returns 0 when estimate exceeds actual (clamped)", () => {
      const messages = [createMessage(1, "hello")];
      // sequenceEstimate=600, actualTokens=500 → clamped to 0
      estimator.recordActual(messages, testModel, 500, 600);

      expect(estimator.getAdjustment("claude")).toBe(0);
    });

    // NOTE: "latest conversationId wins" test deleted - zombie test (RFC 00054)
    // Per-conversation keying removed in favor of family-only keying

    it("clears family-key adjustment when summarization detected", () => {
      const messages = [createMessage(1, "hello")];
      // Establish adjustment: actual=500, estimate=400 → adjustment=100
      estimator.recordActual(messages, testModel, 500, 400);
      expect(estimator.getAdjustment("claude")).toBe(100);

      // Summarization detected — should clear family-key adjustment
      const summaryMessages = [
        createMessage(
          1,
          "<conversation-summary>\nSummary of conversation\n</conversation-summary>",
        ),
      ];
      estimator.recordActual(
        summaryMessages,
        testModel,
        30000,
        25000,
        true,
      );

      // Family-key adjustment should be 0 (cleared)
      expect(estimator.getAdjustment("claude")).toBe(0);
    });

    it("re-establishes adjustment after summarization on next normal turn", () => {
      const messages = [createMessage(1, "hello")];

      // Turn 1: establish adjustment
      estimator.recordActual(messages, testModel, 500, 400);
      expect(estimator.getAdjustment("claude")).toBe(100);

      // Turn 2: summarization — clears
      estimator.recordActual(messages, testModel, 200, 150, true);
      expect(estimator.getAdjustment("claude")).toBe(0);

      // Turn 3: normal — re-establishes
      estimator.recordActual(messages, testModel, 250, 200);
      expect(estimator.getAdjustment("claude")).toBe(50);
    });
  });

  describe("rolling correction in estimateMessage", () => {
    it("applies correction to first message of a new sequence", () => {
      const messages = [createMessage(1, "hello")];
      // Record actual=500, sequenceEstimate=400 → adjustment=100
      estimator.recordActual(messages, testModel, 500, 400);

      // First call is first in sequence → gets correction
      // "test msg" = 8 chars = 8 tokens (mock) + 100 adjustment = 108
      const estimate = estimator.estimateMessage("test msg", testModel);
      expect(estimate).toBe(108);
    });

    it("does NOT apply correction to subsequent messages in same sequence", () => {
      const messages = [createMessage(1, "hello")];
      estimator.recordActual(messages, testModel, 500, 400);

      // First call gets correction
      estimator.estimateMessage("first", testModel);

      // Second call is NOT first in sequence → no correction
      // "second" = 6 chars = 6 tokens (mock), no adjustment
      const estimate = estimator.estimateMessage("second", testModel);
      expect(estimate).toBe(6);
    });

    it("does NOT apply correction when adjustment is zero", () => {
      const messages = [createMessage(1, "hello")];
      // exact match: sequenceEstimate=500, actualTokens=500 → adjustment=0
      estimator.recordActual(messages, testModel, 500, 500);

      // "test msg" = 8 chars = 8 tokens (mock), no adjustment since it's 0
      const estimate = estimator.estimateMessage("test msg", testModel);
      expect(estimate).toBe(8);
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

  // ──────────────────────────────────────────────────────────────
  // RFC 047 Phase 3: Integration & Edge Case Tests
  // ──────────────────────────────────────────────────────────────

  describe("telescoping property (RFC 047 integration)", () => {
    /**
     * These tests verify the core property from RFC 047:
     *   sum(provideTokenCount) = previousActual + tiktoken(new messages)
     *
     * They simulate multi-turn conversations where each turn is a burst
     * of estimateMessage() calls separated by a 500ms+ gap.
     *
     * Mock tiktoken returns text.length as the token count.
     */

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("two-turn: sum equals previousActual + tiktoken(new)", () => {
      // Turn 1: 3 messages via estimateMessage (simulating provideTokenCount)
      const msg1 = createMessage(1, "hello"); // 5 tokens
      const msg2 = createMessage(2, "world"); // 5 tokens
      const msg3 = createMessage(1, "how are you"); // 11 tokens

      const est1 = estimator.estimateMessage(msg1, testModel); // 5
      const est2 = estimator.estimateMessage(msg2, testModel); // 5
      const est3 = estimator.estimateMessage(msg3, testModel); // 11
      const turn1Estimate = est1 + est2 + est3; // 21
      expect(turn1Estimate).toBe(21);

      // Capture sequence total (what VS Code saw)
      const seqEstimate = estimator.getCurrentSequence()?.totalEstimate;
      expect(seqEstimate).toBe(21);

      // API returns actual=80 (much higher, as in production)
      const turn1Actual = 80;
      estimator.recordActual(
        [msg1, msg2, msg3],
        testModel,
        turn1Actual,
        seqEstimate,
      );

      // Advance past 500ms gap → new turn
      vi.advanceTimersByTime(501);

      // Turn 2: same 3 messages + 1 new message
      const msg4 = createMessage(1, "new stuff"); // 9 tokens

      const t2est1 = estimator.estimateMessage(msg1, testModel); // 5 + 59 adjustment = 64
      const t2est2 = estimator.estimateMessage(msg2, testModel); // 5
      const t2est3 = estimator.estimateMessage(msg3, testModel); // 11
      const t2est4 = estimator.estimateMessage(msg4, testModel); // 9
      const turn2Total = t2est1 + t2est2 + t2est3 + t2est4;

      // Telescoping property: sum = previousActual + tiktoken(new messages)
      // tiktoken(all 4) = 5 + 5 + 11 + 9 = 30
      // tiktoken(new only) = 9  (msg4 is the only new message)
      // Expected: 80 + 9 = 89
      //
      // Derivation:
      //   adjustment = actual(80) - seqEstimate(21) = 59
      //   turn2Total = (5+59) + 5 + 11 + 9 = 89
      //   = 80 + (5 + 11 + 9 - 5 - 11) + 9 ... simplifies to actual + tiktoken(new)
      //
      // But more precisely: turn2Total = tiktoken(all) + adjustment = 30 + 59 = 89
      // And: previousActual + tiktoken(new) = 80 + 9 = 89 ✓
      expect(turn2Total).toBe(turn1Actual + 9);
    });

    it("three-turn: adjustment updates based on latest error", () => {
      // The rolling correction applies the MARGINAL error from the most
      // recent turn. Each turn's correction is independent — it corrects
      // the difference between what VS Code saw and what the API reported.

      // Turn 1: pure tiktoken (no prior data)
      const msg1 = createMessage(1, "aaa"); // 3 tokens
      const msg2 = createMessage(2, "bbb"); // 3 tokens

      estimator.estimateMessage(msg1, testModel);
      estimator.estimateMessage(msg2, testModel);
      const seq1 = estimator.getCurrentSequence()?.totalEstimate; // 6
      expect(seq1).toBe(6);

      const turn1Actual = 50;
      estimator.recordActual(
        [msg1, msg2],
        testModel,
        turn1Actual,
        seq1,
      );

      // Turn 2: telescoping holds (turn 1→2)
      vi.advanceTimersByTime(501);
      const msg3 = createMessage(1, "cc"); // 2 tokens

      // adjustment = 50 - 6 = 44
      const t2est1 = estimator.estimateMessage(msg1, testModel); // 3 + 44 = 47
      const t2est2 = estimator.estimateMessage(msg2, testModel); // 3
      const t2est3 = estimator.estimateMessage(msg3, testModel); // 2
      const turn2Total = t2est1 + t2est2 + t2est3;

      expect(turn2Total).toBe(turn1Actual + 2); // 50 + 2 = 52 ✓

      // Record turn 2 actual
      const seq2 = estimator.getCurrentSequence()?.totalEstimate;
      expect(seq2).toBe(52);
      const turn2Actual = 70;
      estimator.recordActual(
        [msg1, msg2, msg3],
        testModel,
        turn2Actual,
        seq2,
      );

      // Turn 3: correction uses marginal error from turn 2
      vi.advanceTimersByTime(501);
      const msg4 = createMessage(1, "d"); // 1 token

      // adjustment = 70 - 52 = 18 (marginal error from turn 2)
      const t3est1 = estimator.estimateMessage(msg1, testModel); // 3 + 18 = 21
      expect(t3est1).toBe(21);
      const t3est2 = estimator.estimateMessage(msg2, testModel); // 3
      const t3est3 = estimator.estimateMessage(msg3, testModel); // 20 (cached)
      const t3est4 = estimator.estimateMessage(msg4, testModel); // 1
      const turn3Total = t3est1 + t3est2 + t3est3 + t3est4;

      // sum = tiktoken(msg1,msg2,msg4) + cached(msg3) + adjustment
      // = (3 + 3 + 1) + 20 + 18 = 45
      expect(turn3Total).toBe(45);

      // The adjustment is the marginal error, not cumulative.
      // This is correct: VS Code saw 52 in turn 2 but actual was 70,
      // so we add 18 to the turn 3 total. The system self-corrects
      // each turn, converging on accuracy.
      expect(estimator.getAdjustment("claude")).toBe(18);
    });

    it("algebraic verification: sum = tiktoken(all) + adjustment", () => {
      // This test verifies the algebraic identity:
      //   sum(provideTokenCount) = tiktoken(allMessages) + adjustment
      //   which equals: previousActual + tiktoken(newMessages)

      const messages = [
        createMessage(1, "alpha"), // 5
        createMessage(2, "beta"), // 4
        createMessage(1, "gamma"), // 5
      ];
      const tiktokenAll = 5 + 4 + 5; // 14

      // Turn 1
      for (const msg of messages) {
        estimator.estimateMessage(msg, testModel);
      }
      const seq1 = estimator.getCurrentSequence()?.totalEstimate;
      expect(seq1).toBe(tiktokenAll); // 14

      const actual = 100;
      estimator.recordActual(messages, testModel, actual, seq1);
      const adjustment = actual - tiktokenAll; // 100 - 14 = 86

      // Turn 2
      vi.advanceTimersByTime(501);
      const newMsg = createMessage(1, "delta"); // 5 tokens
      const allMessages = [...messages, newMsg];
      const tiktokenNew = 5;

      let turn2Sum = 0;
      for (const msg of allMessages) {
        turn2Sum += estimator.estimateMessage(msg, testModel);
      }

      // Verify both forms of the identity
      expect(turn2Sum).toBe(tiktokenAll + tiktokenNew + adjustment); // 14 + 5 + 86 = 105
      expect(turn2Sum).toBe(actual + tiktokenNew); // 100 + 5 = 105
    });

    it("no correction on first turn (no prior data)", () => {
      const msg1 = createMessage(1, "hello"); // 5 tokens
      const msg2 = createMessage(2, "world"); // 5 tokens

      const est1 = estimator.estimateMessage(msg1, testModel);
      const est2 = estimator.estimateMessage(msg2, testModel);

      // First turn: no prior actual, so pure tiktoken
      expect(est1).toBe(5);
      expect(est2).toBe(5);
      expect(est1 + est2).toBe(10);
    });

    it("zero adjustment when estimate matches actual exactly", () => {
      const msg1 = createMessage(1, "hello"); // 5 tokens

      estimator.estimateMessage(msg1, testModel);
      const seq1 = estimator.getCurrentSequence()?.totalEstimate; // 5

      // Actual matches estimate exactly
      estimator.recordActual([msg1], testModel, 5, seq1);

      vi.advanceTimersByTime(501);

      const msg2 = createMessage(1, "world"); // 5 tokens
      const est = estimator.estimateMessage(msg2, testModel);

      // No adjustment: 5 - 5 = 0
      expect(est).toBe(5);
    });
  });

  describe("edge cases (RFC 047)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("cached API actual still applies correction", () => {
      const msg1 = createMessage(1, "hello"); // 5 tokens
      const msg2 = createMessage(2, "world"); // 5 tokens

      // Turn 1
      estimator.estimateMessage(msg1, testModel);
      estimator.estimateMessage(msg2, testModel);
      const seq1 = estimator.getCurrentSequence()?.totalEstimate; // 10

      estimator.recordActual([msg1, msg2], testModel, 100, seq1);

      // Cache msg1's actual from API
      estimator.cacheActual(msg1, "claude", 42);

      vi.advanceTimersByTime(501);

      // Turn 2: msg1 is cached, msg2 is estimated
      // msg1 is first in sequence AND cached → applies correction
      const est1 = estimator.estimateMessage(msg1, testModel);
      expect(est1).toBe(132); // cached + correction (42 + 90)

      // msg2 is second in sequence → no correction applied (correction only on first)
      const est2 = estimator.estimateMessage(msg2, testModel);
      expect(est2).toBe(5); // plain tiktoken
    });

    // NOTE: "multiple conversations get independent corrections" test deleted
    // Per-conversation keying removed in favor of family-only keying (RFC 00054)

    it("reset clears all corrections", () => {
      const msg = createMessage(1, "hello"); // 5 tokens

      estimator.estimateMessage(msg, testModel);
      const seq = estimator.getCurrentSequence()?.totalEstimate;
      estimator.recordActual([msg], testModel, 100, seq);

      expect(estimator.getAdjustment("claude")).toBe(95); // 100 - 5

      estimator.reset();

      expect(estimator.getAdjustment("claude")).toBe(0);
      expect(estimator.getCurrentSequence()).toBeNull();
    });

    it("large ratio correction matches production scenario", () => {
      // Simulates the 1.52x ratio from production logs:
      // 216 messages, tiktoken=71605, actual=109148

      // We'll use smaller numbers with the same ratio
      // 10 messages of "abcdefg" (7 tokens each) = 70 tiktoken total
      const messages = Array.from({ length: 10 }, (_, i) =>
        createMessage(i % 2 === 0 ? 1 : 2, "abcdefg"),
      );

      // Turn 1
      for (const msg of messages) {
        estimator.estimateMessage(msg, testModel);
      }
      const seq1 = estimator.getCurrentSequence()?.totalEstimate;
      expect(seq1).toBe(70);

      // Actual is ~1.52x higher
      const actual = 106;
      estimator.recordActual(messages, testModel, actual, seq1);
      expect(estimator.getAdjustment("claude")).toBe(36); // 106 - 70

      vi.advanceTimersByTime(501);

      // Turn 2: same messages + 2 new
      const newMsg1 = createMessage(1, "new one"); // 7 tokens
      const newMsg2 = createMessage(2, "new two"); // 7 tokens
      const allMessages = [...messages, newMsg1, newMsg2];

      let turn2Sum = 0;
      for (const msg of allMessages) {
        turn2Sum += estimator.estimateMessage(msg, testModel);
      }

      // tiktoken(all 12 messages) = 12 * 7 = 84
      // adjustment = 36
      // turn2Sum = 84 + 36 = 120
      // = actual(106) + tiktoken(new: 7+7=14) = 120 ✓
      expect(turn2Sum).toBe(actual + 7 + 7);
    });
  });

  describe("logging (RFC 047)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      loggerHoisted.debug.mockClear();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("logs adjustment when correction is applied", () => {
      const msg = createMessage(1, "hello"); // 5 tokens
      estimator.recordActual([msg], testModel, 100, 5);

      loggerHoisted.debug.mockClear(); // clear any prior logs

      // First message of new turn should log the correction
      estimator.estimateMessage("test", testModel);

      expect(loggerHoisted.debug).toHaveBeenCalledWith(
        expect.stringContaining("Rolling correction"),
      );
      // Verify it includes the numbers: estimate + adjustment = total
      expect(loggerHoisted.debug).toHaveBeenCalledWith(
        expect.stringContaining("4 + 95 = 99"),
      );
    });

    it("does NOT log when adjustment is zero", () => {
      const msg = createMessage(1, "hello"); // 5 tokens
      // exact match → adjustment = 0
      estimator.recordActual([msg], testModel, 5, 5);

      loggerHoisted.debug.mockClear();

      estimator.estimateMessage("test", testModel);

      expect(loggerHoisted.debug).not.toHaveBeenCalledWith(
        expect.stringContaining("Rolling correction"),
      );
    });
  });
});
