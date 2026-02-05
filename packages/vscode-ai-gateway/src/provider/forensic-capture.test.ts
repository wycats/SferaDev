/**
 * Tests for A3 assumption: normalize(transform_out(x)) = normalize(x)
 *
 * A3: Our normalization correctly strips all additions we inject during output.
 *
 * Per digest-equivalence-algebra.md Section 6:
 * - transform_out injects URL annotations: ` [title](url)`
 * - normalize must strip these back to get the original content
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

vi.mock("vscode", () => ({
  LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn(() => false),
    })),
  },
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  stripOurAdditions,
  computeNormalizedDigest,
  computeRawDigest,
} from "./forensic-capture.js";

describe("stripOurAdditions", () => {
  it("strips single URL annotation", () => {
    const input = "Check out this link [Example](https://example.com)";
    const result = stripOurAdditions(input);
    expect(result).toBe("Check out this link");
  });

  it("strips multiple URL annotations", () => {
    const input =
      "See [First](https://first.com) and [Second](https://second.com) links";
    const result = stripOurAdditions(input);
    expect(result).toBe("See and links");
  });

  it("preserves text without annotations", () => {
    const input = "Plain text without any links";
    const result = stripOurAdditions(input);
    expect(result).toBe("Plain text without any links");
  });

  it("handles empty string", () => {
    const result = stripOurAdditions("");
    expect(result).toBe("");
  });

  it("strips annotation at end of text", () => {
    const input = "See the docs [Documentation](https://docs.example.com)";
    const result = stripOurAdditions(input);
    expect(result).toBe("See the docs");
  });

  it("handles URLs with special characters", () => {
    const input =
      "Link [Query](https://example.com/search?q=test&sort=asc) here";
    const result = stripOurAdditions(input);
    expect(result).toBe("Link here");
  });

  it("handles markdown links with complex titles", () => {
    const input = "Check [Docs: Getting Started](https://docs.io/start) now";
    const result = stripOurAdditions(input);
    expect(result).toBe("Check now");
  });
});

describe("A3 assumption: normalize(transform_out(x)) = normalize(x)", () => {
  // Simulate transform_out by adding URL annotations
  function transformOut(text: string): string {
    // This simulates what stream-adapter.ts does
    return `${text} [Citation](https://example.com)`;
  }

  // Create a mock message for testing
  function createMockMessage(text: string) {
    return {
      role: 2, // Assistant
      content: [
        {
          value: text,
        },
      ],
    };
  }

  it("normalized digest is stable after transform_out", () => {
    const original = "This is the response content.";
    const transformed = transformOut(original);

    const originalMsg = createMockMessage(original);
    const transformedMsg = createMockMessage(transformed);

    const originalDigest = computeNormalizedDigest(
      originalMsg as Parameters<typeof computeNormalizedDigest>[0],
    );
    const transformedDigest = computeNormalizedDigest(
      transformedMsg as Parameters<typeof computeNormalizedDigest>[0],
    );

    expect(transformedDigest).toBe(originalDigest);
  });

  it("normalized digest is stable with multiple annotations", () => {
    const original = "Response with citations.";
    const transformed = `${original} [Ref1](https://ref1.com) [Ref2](https://ref2.com)`;

    const originalMsg = createMockMessage(original);
    const transformedMsg = createMockMessage(transformed);

    const originalDigest = computeNormalizedDigest(
      originalMsg as Parameters<typeof computeNormalizedDigest>[0],
    );
    const transformedDigest = computeNormalizedDigest(
      transformedMsg as Parameters<typeof computeNormalizedDigest>[0],
    );

    expect(transformedDigest).toBe(originalDigest);
  });

  it("normalized digest is stable when original has no annotations", () => {
    const original = "Simple text.";

    const msg = createMockMessage(original);
    const digest1 = computeNormalizedDigest(
      msg as Parameters<typeof computeNormalizedDigest>[0],
    );
    const digest2 = computeNormalizedDigest(
      msg as Parameters<typeof computeNormalizedDigest>[0],
    );

    expect(digest1).toBe(digest2);
  });

  it("idempotence: strip(strip(x)) = strip(x)", () => {
    const withAnnotations =
      "Text [Link1](https://url1.com) more [Link2](https://url2.com)";

    const once = stripOurAdditions(withAnnotations);
    const twice = stripOurAdditions(once);

    expect(twice).toBe(once);
    expect(twice).toBe("Text more");
  });
});

describe("A4 assumption: Tool callId stability", () => {
  /**
   * A4: Tool call IDs (callId/itemId) are stable across conversation turns.
   *
   * The normalized digest excludes callId (since we can't control its generation),
   * but the raw digest and forensic capture track it for verification.
   */

  type MockMessage = Parameters<typeof computeNormalizedDigest>[0];

  // Create a mock message with tool call
  function createToolCallMessage(toolName: string, callId: string): MockMessage {
    return {
      role: 2, // Assistant
      content: [
        {
          callId,
          name: toolName,
          input: { query: "test" },
        },
      ],
    } as unknown as MockMessage;
  }

  // Create a mock message with tool result
  function createToolResultMessage(
    toolName: string,
    callId: string,
  ): MockMessage {
    return {
      role: 1, // User
      content: [
        {
          callId,
          name: toolName,
          toolResult: { success: true },
        },
      ],
    } as unknown as MockMessage;
  }

  it("normalized digest excludes callId", () => {
    const msg1 = createToolCallMessage("read_file", "call_abc123");
    const msg2 = createToolCallMessage("read_file", "call_xyz789");

    const digest1 = computeNormalizedDigest(msg1);
    const digest2 = computeNormalizedDigest(msg2);

    // Same tool call, different callId => same normalized digest
    expect(digest1).toBe(digest2);
  });

  it("raw digest includes callId", () => {
    const msg1 = createToolCallMessage("read_file", "call_abc123");
    const msg2 = createToolCallMessage("read_file", "call_xyz789");

    const digest1 = computeRawDigest(msg1);
    const digest2 = computeRawDigest(msg2);

    // Same tool call, different callId => different raw digest
    expect(digest1).not.toBe(digest2);
  });

  it("normalized digest matches for tool results with different callIds", () => {
    const msg1 = createToolResultMessage("read_file", "result_abc");
    const msg2 = createToolResultMessage("read_file", "result_xyz");

    const digest1 = computeNormalizedDigest(msg1);
    const digest2 = computeNormalizedDigest(msg2);

    expect(digest1).toBe(digest2);
  });

  it("normalized digest differs for different tool names", () => {
    const msg1 = createToolCallMessage("read_file", "call_123");
    const msg2 = createToolCallMessage("grep_search", "call_123");

    const digest1 = computeNormalizedDigest(msg1);
    const digest2 = computeNormalizedDigest(msg2);

    // Different tool => different digest even with same callId
    expect(digest1).not.toBe(digest2);
  });
});
