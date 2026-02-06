import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock vscode module (required by logger)
vi.mock("vscode", () => ({
  window: {
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      dispose: vi.fn(),
    })),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn(),
    })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
  },
}));

import { CallSequenceTracker, type TokenEstimate } from "./sequence-tracker";

describe("CallSequenceTracker", () => {
  let tracker: CallSequenceTracker;

  beforeEach(() => {
    tracker = new CallSequenceTracker();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const makeEstimate = (
    tokens: number,
    source: TokenEstimate["source"] = "tiktoken",
  ): TokenEstimate => ({
    tokens,
    confidence: "medium",
    source,
    margin: 0.1,
  });

  describe("sequence creation", () => {
    it("creates a new sequence on first call", () => {
      expect(tracker.getCurrentSequence()).toBeNull();

      tracker.onCall(makeEstimate(100));

      const sequence = tracker.getCurrentSequence();
      expect(sequence).not.toBeNull();
      expect(sequence?.calls).toHaveLength(1);
      expect(sequence?.totalEstimate).toBe(100);
    });

    it("accumulates calls within the same sequence", () => {
      tracker.onCall(makeEstimate(100));
      vi.advanceTimersByTime(100); // 100ms gap
      tracker.onCall(makeEstimate(200));
      vi.advanceTimersByTime(100); // 100ms gap
      tracker.onCall(makeEstimate(50));

      const sequence = tracker.getCurrentSequence();
      expect(sequence?.calls).toHaveLength(3);
      expect(sequence?.totalEstimate).toBe(350);
    });

    it("tracks call sources", () => {
      tracker.onCall(makeEstimate(100, "api-actual"));
      tracker.onCall(makeEstimate(200, "calibrated"));
      tracker.onCall(makeEstimate(50, "tiktoken"));

      const sequence = tracker.getCurrentSequence();
      expect(sequence?.calls[0]?.source).toBe("api-actual");
      expect(sequence?.calls[1]?.source).toBe("calibrated");
      expect(sequence?.calls[2]?.source).toBe("tiktoken");
    });
  });

  describe("gap detection", () => {
    it("starts a new sequence after 500ms gap", () => {
      tracker.onCall(makeEstimate(100));
      const firstSequence = tracker.getCurrentSequence();

      vi.advanceTimersByTime(501); // Just over 500ms gap
      tracker.onCall(makeEstimate(200));

      const secondSequence = tracker.getCurrentSequence();
      expect(secondSequence).not.toBe(firstSequence);
      expect(secondSequence?.calls).toHaveLength(1);
      expect(secondSequence?.totalEstimate).toBe(200);
    });

    it("continues sequence at exactly 500ms gap", () => {
      tracker.onCall(makeEstimate(100));
      vi.advanceTimersByTime(500); // Exactly 500ms gap
      tracker.onCall(makeEstimate(200));

      const sequence = tracker.getCurrentSequence();
      expect(sequence?.calls).toHaveLength(2);
      expect(sequence?.totalEstimate).toBe(300);
    });

    it("uses lastCallTime not startTime for gap detection", () => {
      // This tests the fix from RFC 029 review:
      // Long renders should not be split into multiple sequences

      tracker.onCall(makeEstimate(100));
      vi.advanceTimersByTime(400); // 400ms since start
      tracker.onCall(makeEstimate(200));
      vi.advanceTimersByTime(400); // 800ms since start, but only 400ms since last call
      tracker.onCall(makeEstimate(300));

      // Should still be one sequence because each gap is < 500ms
      const sequence = tracker.getCurrentSequence();
      expect(sequence?.calls).toHaveLength(3);
      expect(sequence?.totalEstimate).toBe(600);
    });
  });

  describe("timing", () => {
    it("tracks startTime correctly", () => {
      const startTime = Date.now();
      tracker.onCall(makeEstimate(100));

      const sequence = tracker.getCurrentSequence();
      expect(sequence?.startTime).toBe(startTime);
    });

    it("updates lastCallTime on each call", () => {
      tracker.onCall(makeEstimate(100));
      const firstCallTime = tracker.getCurrentSequence()?.lastCallTime;

      vi.advanceTimersByTime(200);
      tracker.onCall(makeEstimate(200));
      const secondCallTime = tracker.getCurrentSequence()?.lastCallTime;

      expect(secondCallTime).toBe(firstCallTime! + 200);
    });
  });

  describe("reset", () => {
    it("clears the current sequence", () => {
      tracker.onCall(makeEstimate(100));
      expect(tracker.getCurrentSequence()).not.toBeNull();

      tracker.reset();
      expect(tracker.getCurrentSequence()).toBeNull();
    });
  });

  describe("H5 verification: first-message detection", () => {
    it("getCurrentSequence() returns OLD sequence before onCall() after gap", () => {
      // Turn 1: make some calls
      tracker.onCall(makeEstimate(100));
      tracker.onCall(makeEstimate(200));
      const turn1Sequence = tracker.getCurrentSequence();
      expect(turn1Sequence?.totalEstimate).toBe(300);

      // Simulate 600ms gap (beyond 500ms threshold)
      vi.advanceTimersByTime(600);

      // KEY TEST: What does getCurrentSequence() return BEFORE the next onCall()?
      const sequenceBeforeCall = tracker.getCurrentSequence();

      // H5 claim: currentSequence should be null
      // Actual behavior: currentSequence is still the OLD sequence
      expect(sequenceBeforeCall).not.toBeNull(); // REFUTES H5
      expect(sequenceBeforeCall).toBe(turn1Sequence); // Same object!
      expect(sequenceBeforeCall?.totalEstimate).toBe(300); // Still has old total

      // Now call onCall() - THIS is when the new sequence is created
      tracker.onCall(makeEstimate(50));
      const turn2Sequence = tracker.getCurrentSequence();

      expect(turn2Sequence).not.toBe(turn1Sequence); // New sequence
      expect(turn2Sequence?.totalEstimate).toBe(50); // Fresh total
      expect(turn2Sequence?.calls).toHaveLength(1); // Only the new call
    });

    it("cannot detect first-message-in-turn by checking currentSequence === null", () => {
      // This test documents WHY the RFC 045 algorithm is wrong

      tracker.onCall(makeEstimate(100));
      vi.advanceTimersByTime(600); // Gap

      // If we check currentSequence before onCall(), it's NOT null
      const isFirstByNullCheck = tracker.getCurrentSequence() === null;
      expect(isFirstByNullCheck).toBe(false); // Wrong signal!

      // The only time currentSequence is null is:
      // 1. Before any calls ever (fresh tracker)
      // 2. After reset()
      tracker.reset();
      expect(tracker.getCurrentSequence()).toBeNull();
    });

    it("CAN detect first-message by comparing sequence identity after onCall()", () => {
      // Alternative approach: check if onCall() created a NEW sequence

      tracker.onCall(makeEstimate(100));
      // First sequence established (not used directly, but needed to set up state)

      vi.advanceTimersByTime(600); // Gap

      const seqBeforeCall = tracker.getCurrentSequence();
      tracker.onCall(makeEstimate(50));
      const seqAfterCall = tracker.getCurrentSequence();

      // We can detect "first in new sequence" by comparing before/after
      const isFirstInNewSequence = seqAfterCall !== seqBeforeCall;
      expect(isFirstInNewSequence).toBe(true);
      // But this requires calling onCall() first, which is too late
      // for applying the adjustment...
    });
  });

  describe("wouldStartNewSequence", () => {
    it("returns true when no sequence exists", () => {
      expect(tracker.wouldStartNewSequence()).toBe(true);
    });

    it("returns false immediately after a call", () => {
      tracker.onCall(makeEstimate(100));
      expect(tracker.wouldStartNewSequence()).toBe(false);
    });

    it("returns false within 500ms gap", () => {
      tracker.onCall(makeEstimate(100));
      vi.advanceTimersByTime(400);
      expect(tracker.wouldStartNewSequence()).toBe(false);
    });

    it("returns true after 500ms gap", () => {
      tracker.onCall(makeEstimate(100));
      vi.advanceTimersByTime(501);
      expect(tracker.wouldStartNewSequence()).toBe(true);
    });

    it("returns true after reset", () => {
      tracker.onCall(makeEstimate(100));
      tracker.reset();
      expect(tracker.wouldStartNewSequence()).toBe(true);
    });

    it("enables correct first-message detection pattern", () => {
      // This test demonstrates the CORRECT pattern for RFC 045

      // Turn 1
      tracker.onCall(makeEstimate(100));
      tracker.onCall(makeEstimate(200));

      vi.advanceTimersByTime(600); // Gap

      // Turn 2 - BEFORE calling onCall, check if this would be first
      const isFirstInTurn2 = tracker.wouldStartNewSequence();
      expect(isFirstInTurn2).toBe(true);

      // Now we can apply adjustment and call onCall
      const adjustment = 25000; // from getAdjustment()
      const estimate = 500 + (isFirstInTurn2 ? adjustment : 0);
      tracker.onCall(makeEstimate(estimate));

      // Subsequent calls in same turn
      expect(tracker.wouldStartNewSequence()).toBe(false);
      tracker.onCall(makeEstimate(500));

      // Verify total includes adjustment
      expect(tracker.getCurrentSequence()?.totalEstimate).toBe(25500 + 500);
    });
  });
});
