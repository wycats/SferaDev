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
});
