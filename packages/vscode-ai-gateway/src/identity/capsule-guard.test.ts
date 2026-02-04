import { describe, it, expect, beforeEach } from "vitest";
import { CapsuleGuard } from "./capsule-guard.js";

describe("CapsuleGuard", () => {
  let guard: CapsuleGuard;

  beforeEach(() => {
    // Create a new guard instance for each test
    guard = new CapsuleGuard();
  });

  describe("processTextDelta", () => {
    it("should process normal text without triggering", () => {
      const result1 = guard.processTextDelta("Hello, ");
      expect(result1.shouldCancel).toBe(false);
      expect(result1.cleanContent).toBe("Hello, ");

      const result2 = guard.processTextDelta("world!");
      expect(result2.shouldCancel).toBe(false);
      expect(result2.cleanContent).toBe("world!");
    });

    it("should detect <!-- v.cid: pattern at buffer end", () => {
      guard.processTextDelta("Normal text here ");
      const result = guard.processTextDelta("<!-- v.cid:abc123");

      expect(result.shouldCancel).toBe(true);
      expect(result.cleanContent).toBe("");
    });

    it("should detect <!-- v.aid: pattern", () => {
      guard.processTextDelta("Some output ");
      const result = guard.processTextDelta("<!-- v.aid:agent_xyz");

      expect(result.shouldCancel).toBe(true);
      expect(result.cleanContent).toBe("");
    });

    it("should detect <!-- v.pid: pattern", () => {
      guard.processTextDelta("More text ");
      const result = guard.processTextDelta("<!-- v.pid:parent_123");

      expect(result.shouldCancel).toBe(true);
      expect(result.cleanContent).toBe("");
    });

    it("should detect pattern spanning buffer boundary", () => {
      // First chunk ends with "<!-- v."
      guard.processTextDelta("Text ending with <!-- v.");
      // Second chunk starts with "cid:" - should trigger
      const result = guard.processTextDelta("cid:conv_abc");

      expect(result.shouldCancel).toBe(true);
      // Should return empty string since entire chunk is part of hallucination
      expect(result.cleanContent).toBe("");
    });

    it("should return clean content truncated before pattern", () => {
      const result = guard.processTextDelta("Good content<!-- v.cid:bad");

      expect(result.shouldCancel).toBe(true);
      expect(result.cleanContent).toBe("Good content");
    });

    it("should handle pattern in middle of text", () => {
      const result = guard.processTextDelta(
        "Start of text <!-- v.aid:fake and more",
      );

      expect(result.shouldCancel).toBe(true);
      expect(result.cleanContent).toBe("Start of text ");
    });

    it("should maintain rolling buffer correctly", () => {
      // Add text longer than BUFFER_SIZE (30)
      guard.processTextDelta("A".repeat(40));

      // Buffer should only contain last 30 chars
      // Add pattern - should still detect
      const result = guard.processTextDelta("<!-- v.cid:test");

      expect(result.shouldCancel).toBe(true);
    });

    it("should handle empty text", () => {
      const result = guard.processTextDelta("");

      expect(result.shouldCancel).toBe(false);
      expect(result.cleanContent).toBe("");
    });

    it("should handle very short text", () => {
      const result = guard.processTextDelta("x");

      expect(result.shouldCancel).toBe(false);
      expect(result.cleanContent).toBe("x");
    });

    it("should accumulate multiple deltas correctly", () => {
      // Build up pattern across multiple deltas
      guard.processTextDelta("Some ");
      guard.processTextDelta("text ");
      guard.processTextDelta("here ");
      guard.processTextDelta("<!-");
      guard.processTextDelta("- v");
      const result = guard.processTextDelta(".cid:abc");

      expect(result.shouldCancel).toBe(true);
      // Since pattern spans multiple chunks, this chunk is part of it
      expect(result.cleanContent).toBe("");
    });

    it("should not trigger on partial pattern without completion", () => {
      const result1 = guard.processTextDelta("<!-- v");
      expect(result1.shouldCancel).toBe(false);

      const result2 = guard.processTextDelta(".");
      expect(result2.shouldCancel).toBe(false);

      // Not a valid capsule field
      const result3 = guard.processTextDelta("xyz:");
      expect(result3.shouldCancel).toBe(false);
    });

    it("should handle legitimate HTML comments", () => {
      const result = guard.processTextDelta(
        "<!-- This is a normal comment -->",
      );

      expect(result.shouldCancel).toBe(false);
      expect(result.cleanContent).toBe("<!-- This is a normal comment -->");
    });

    it("should detect pattern after legitimate content", () => {
      guard.processTextDelta("Here is my answer:\n\n");
      guard.processTextDelta("1. First point\n");
      guard.processTextDelta("2. Second point\n\n");

      const result = guard.processTextDelta("<!-- v.cid:hallucinated");

      expect(result.shouldCancel).toBe(true);
      expect(result.cleanContent).toBe("");
    });

    it("should handle pattern split across buffer boundary with clean content", () => {
      // Chunk ends with start of pattern
      guard.processTextDelta("Valid output here <!-");
      // Next chunk completes the pattern
      const result = guard.processTextDelta("- v.aid:fake");

      expect(result.shouldCancel).toBe(true);
      // The entire second chunk is part of the pattern
      expect(result.cleanContent).toBe("");
    });

    it("should preserve content before pattern when pattern appears mid-stream", () => {
      guard.processTextDelta("This is ");
      guard.processTextDelta("valid ");

      const result = guard.processTextDelta("output<!-- v.pid:bad");

      expect(result.shouldCancel).toBe(true);
      expect(result.cleanContent).toBe("output");
    });
  });

  describe("edge cases", () => {
    it("should handle repeated pattern detection calls", () => {
      const result1 = guard.processTextDelta("text<!-- v.cid:abc");
      expect(result1.shouldCancel).toBe(true);

      // Subsequent calls should still work (though stream should be cancelled)
      const result2 = guard.processTextDelta(" more text");
      // Pattern still in buffer, should still detect
      expect(result2.shouldCancel).toBe(true);
    });

    it("should handle pattern at very start of stream", () => {
      const result = guard.processTextDelta("<!-- v.cid:immediate");

      expect(result.shouldCancel).toBe(true);
      expect(result.cleanContent).toBe("");
    });

    it("should handle multiple patterns in single chunk", () => {
      const result = guard.processTextDelta(
        "<!-- v.cid:first <!-- v.aid:second",
      );

      expect(result.shouldCancel).toBe(true);
      // Should truncate at first pattern
      expect(result.cleanContent).toBe("");
    });
  });
});
