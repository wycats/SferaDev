import { describe, it, expect } from "vitest";
import {
  computeToolSetHash,
  computeAgentTypeHash,
  computeConversationHash,
  hashFirstAssistantResponse,
  hashUserMessage,
} from "./hash-utils.js";

describe("computeToolSetHash", () => {
  it("produces same hash regardless of tool order", () => {
    const tools1 = [{ name: "read_file" }, { name: "write_file" }];
    const tools2 = [{ name: "write_file" }, { name: "read_file" }];
    expect(computeToolSetHash(tools1 as any)).toBe(
      computeToolSetHash(tools2 as any),
    );
  });

  it("produces different hash for different tool sets", () => {
    const tools1 = [{ name: "read_file" }];
    const tools2 = [{ name: "write_file" }];
    expect(computeToolSetHash(tools1 as any)).not.toBe(
      computeToolSetHash(tools2 as any),
    );
  });

  it("returns 16-character hex string", () => {
    const hash = computeToolSetHash([{ name: "test" }] as any);
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe("computeAgentTypeHash", () => {
  it("combines system prompt and tool set hashes", () => {
    const hash = computeAgentTypeHash("abc123", "def456");
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it("produces different hash for different inputs", () => {
    const hash1 = computeAgentTypeHash("abc", "def");
    const hash2 = computeAgentTypeHash("abc", "ghi");
    expect(hash1).not.toBe(hash2);
  });
});

describe("computeConversationHash", () => {
  it("combines all three inputs", () => {
    const hash = computeConversationHash("type", "user", "assistant");
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it("is stable for same inputs", () => {
    const hash1 = computeConversationHash("a", "b", "c");
    const hash2 = computeConversationHash("a", "b", "c");
    expect(hash1).toBe(hash2);
  });
});

describe("hashFirstAssistantResponse", () => {
  it("truncates to 500 characters", () => {
    const longText = "a".repeat(1000);
    const hash1 = hashFirstAssistantResponse(longText);
    const hash2 = hashFirstAssistantResponse("a".repeat(500));
    expect(hash1).toBe(hash2);
  });

  it("trims whitespace", () => {
    const hash1 = hashFirstAssistantResponse("  hello  ");
    const hash2 = hashFirstAssistantResponse("hello");
    expect(hash1).toBe(hash2);
  });

  it("handles empty string", () => {
    const hash = hashFirstAssistantResponse("");
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe("hashUserMessage", () => {
  it("trims whitespace", () => {
    const hash1 = hashUserMessage("  test  ");
    const hash2 = hashUserMessage("test");
    expect(hash1).toBe(hash2);
  });
});
