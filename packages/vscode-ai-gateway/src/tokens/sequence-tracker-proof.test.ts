/**
 * PROOF TEST: Verifies that wouldStartNewSequence() correctly predicts
 * whether onCall() will create a new sequence.
 * 
 * This is critical for RFC 045 - we need to know BEFORE calling onCall()
 * whether this is the first message in a turn, so we can apply the adjustment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("PROOF: wouldStartNewSequence() predicts onCall() behavior", () => {
  let tracker: CallSequenceTracker;

  beforeEach(() => {
    tracker = new CallSequenceTracker();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const makeEstimate = (tokens: number): TokenEstimate => ({
    tokens,
    confidence: "medium",
    source: "tiktoken",
    margin: 0.1,
  });

  /**
   * Helper: Check if onCall() created a new sequence by comparing
   * the sequence object before and after.
   */
  function didOnCallCreateNewSequence(): boolean {
    const seqBefore = tracker.getCurrentSequence();
    tracker.onCall(makeEstimate(100));
    const seqAfter = tracker.getCurrentSequence();
    return seqAfter !== seqBefore;
  }

  it("PROOF 1: Both agree when no sequence exists", () => {
    const prediction = tracker.wouldStartNewSequence();
    const actual = didOnCallCreateNewSequence();
    
    expect(prediction).toBe(true);
    expect(actual).toBe(true);
    expect(prediction).toBe(actual);
  });

  it("PROOF 2: Both agree immediately after a call (no gap)", () => {
    tracker.onCall(makeEstimate(100)); // Create sequence
    
    const prediction = tracker.wouldStartNewSequence();
    const actual = didOnCallCreateNewSequence();
    
    expect(prediction).toBe(false);
    expect(actual).toBe(false);
    expect(prediction).toBe(actual);
  });

  it("PROOF 3: Both agree at exactly 500ms (boundary)", () => {
    tracker.onCall(makeEstimate(100));
    vi.advanceTimersByTime(500); // Exactly at threshold
    
    const prediction = tracker.wouldStartNewSequence();
    const actual = didOnCallCreateNewSequence();
    
    // Both use > (not >=), so 500ms should NOT trigger new sequence
    expect(prediction).toBe(false);
    expect(actual).toBe(false);
    expect(prediction).toBe(actual);
  });

  it("PROOF 4: Both agree at 501ms (just over threshold)", () => {
    tracker.onCall(makeEstimate(100));
    vi.advanceTimersByTime(501);
    
    const prediction = tracker.wouldStartNewSequence();
    const actual = didOnCallCreateNewSequence();
    
    expect(prediction).toBe(true);
    expect(actual).toBe(true);
    expect(prediction).toBe(actual);
  });

  it("PROOF 5: Both agree after reset", () => {
    tracker.onCall(makeEstimate(100));
    tracker.reset();
    
    const prediction = tracker.wouldStartNewSequence();
    const actual = didOnCallCreateNewSequence();
    
    expect(prediction).toBe(true);
    expect(actual).toBe(true);
    expect(prediction).toBe(actual);
  });

  it("PROOF 6: Prediction matches actual across 100 random scenarios", () => {
    let mismatches = 0;
    
    for (let scenario = 0; scenario < 100; scenario++) {
      // Fresh tracker for each scenario
      tracker = new CallSequenceTracker();
      vi.setSystemTime(0);
      
      // Random sequence of calls with random gaps
      const numCalls = Math.floor(Math.random() * 10) + 1;
      
      for (let call = 0; call < numCalls; call++) {
        const gap = Math.floor(Math.random() * 1000); // 0-999ms
        vi.advanceTimersByTime(gap);
        
        const prediction = tracker.wouldStartNewSequence();
        const actual = didOnCallCreateNewSequence();
        
        if (prediction !== actual) {
          mismatches++;
          console.error(`Mismatch in scenario ${scenario}, call ${call}: ` +
            `gap=${gap}ms, prediction=${prediction}, actual=${actual}`);
        }
      }
    }
    
    expect(mismatches).toBe(0);
  });

  it("PROOF 7: The RFC 045 usage pattern works correctly", () => {
    // Simulate Turn 1
    tracker.onCall(makeEstimate(100));
    tracker.onCall(makeEstimate(200));
    tracker.onCall(makeEstimate(300));
    const turn1Total = tracker.getCurrentSequence()?.totalEstimate;
    expect(turn1Total).toBe(600);
    
    // Gap between turns
    vi.advanceTimersByTime(600);
    
    // Turn 2: The RFC 045 pattern
    // 1. Check if this would be first message
    const isFirst = tracker.wouldStartNewSequence();
    expect(isFirst).toBe(true);
    
    // 2. If first, apply adjustment (simulated)
    const adjustment = isFirst ? 25000 : 0;
    const estimate = 100 + adjustment;
    
    // 3. Record the call with adjusted estimate
    tracker.onCall(makeEstimate(estimate));
    
    // 4. Verify the sequence has the adjusted total
    expect(tracker.getCurrentSequence()?.totalEstimate).toBe(25100);
    
    // 5. Subsequent calls should NOT get adjustment
    expect(tracker.wouldStartNewSequence()).toBe(false);
    tracker.onCall(makeEstimate(200));
    expect(tracker.getCurrentSequence()?.totalEstimate).toBe(25300);
  });
});
