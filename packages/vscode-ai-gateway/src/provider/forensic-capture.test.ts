/**
 * Tests for canonical projection: normalize(transform_out(x)) != normalize(x)
 *
 * Canonical normalization preserves output text including citations/links.
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
  computeNormalizedDigest,
  computeRawDigest,
} from "./forensic-capture.js";

describe("Canonical projection: normalize(transform_out(x)) preserves additions", () => {
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

  it("normalized digest changes after transform_out", () => {
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

    expect(transformedDigest).not.toBe(originalDigest);
  });

  it("normalized digest changes with multiple annotations", () => {
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

    expect(transformedDigest).not.toBe(originalDigest);
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
  function createToolCallMessage(
    toolName: string,
    callId: string,
  ): MockMessage {
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
