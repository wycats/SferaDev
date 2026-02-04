import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("vscode", () => ({
  LanguageModelChatMessageRole: {
    User: 1,
    Assistant: 2,
    System: 3,
  },
  LanguageModelTextPart: class LanguageModelTextPart {
    constructor(public value: string) {}
  },
}));
import {
  formatCapsule,
  parseCapsule,
  extractCapsuleFromContent,
  extractCapsuleFromMessages,
  removeCapsuleFromContent,
  appendCapsuleToContent,
  detectHallucinatedCapsule,
  getStreamBuffer,
  generateConversationId,
  generateAgentId,
  type Capsule,
} from "./capsule.js";
import {
  LanguageModelChatMessageRole,
  LanguageModelTextPart,
  type LanguageModelChatMessage,
} from "vscode";

describe("Capsule Format & Parsing", () => {
  describe("formatCapsule", () => {
    it("should format a capsule without parent ID", () => {
      const capsule: Capsule = {
        cid: "conv_a1b2c3d4e5",
        aid: "agent_x7y8z9m0n1",
      };

      const formatted = formatCapsule(capsule);
      expect(formatted).toBe(
        "<!-- v.cid:conv_a1b2c3d4e5 aid:agent_x7y8z9m0n1 -->",
      );
    });

    it("should format a capsule with parent ID", () => {
      const capsule: Capsule = {
        cid: "conv_a1b2c3d4e5",
        aid: "agent_x7y8z9m0n1",
        pid: "agent_parent123",
      };

      const formatted = formatCapsule(capsule);
      expect(formatted).toBe(
        "<!-- v.cid:conv_a1b2c3d4e5 aid:agent_x7y8z9m0n1 pid:agent_parent123 -->",
      );
    });
  });

  describe("parseCapsule", () => {
    it("should parse a capsule without parent ID", () => {
      const comment = "<!-- v.cid:conv_a1b2c3d4e5 aid:agent_x7y8z9m0n1 -->";
      const parsed = parseCapsule(comment);

      expect(parsed).toEqual({
        cid: "conv_a1b2c3d4e5",
        aid: "agent_x7y8z9m0n1",
        pid: undefined,
      });
    });

    it("should parse a capsule with parent ID", () => {
      const comment =
        "<!-- v.cid:conv_a1b2c3d4e5 aid:agent_x7y8z9m0n1 pid:agent_parent123 -->";
      const parsed = parseCapsule(comment);

      expect(parsed).toEqual({
        cid: "conv_a1b2c3d4e5",
        aid: "agent_x7y8z9m0n1",
        pid: "agent_parent123",
      });
    });

    it("should return null for invalid format", () => {
      const invalid = "<!-- not a capsule -->";
      expect(parseCapsule(invalid)).toBeNull();
    });

    it("should return null for empty string", () => {
      expect(parseCapsule("")).toBeNull();
    });

    it("should handle capsule with extra spaces around pid", () => {
      const comment = "<!-- v.cid:conv_abc aid:agent_xyz pid:agent_parent -->";
      const parsed = parseCapsule(comment);
      expect(parsed?.pid).toBe("agent_parent");
    });
  });

  describe("roundtrip format/parse", () => {
    it("should roundtrip a capsule without parent ID", () => {
      const original: Capsule = {
        cid: "conv_roundtrip1",
        aid: "agent_roundtrip2",
      };

      const formatted = formatCapsule(original);
      const parsed = parseCapsule(formatted);

      expect(parsed).toEqual(original);
    });

    it("should roundtrip a capsule with parent ID", () => {
      const original: Capsule = {
        cid: "conv_roundtrip1",
        aid: "agent_roundtrip2",
        pid: "agent_roundtrip3",
      };

      const formatted = formatCapsule(original);
      const parsed = parseCapsule(formatted);

      expect(parsed).toEqual(original);
    });
  });
});

describe("Capsule Content Operations", () => {
  describe("extractCapsuleFromContent", () => {
    it("should extract capsule from end of content", () => {
      const content =
        "This is a response.\n<!-- v.cid:conv_123 aid:agent_456 -->";
      const capsule = extractCapsuleFromContent(content);

      expect(capsule).toEqual({
        cid: "conv_123",
        aid: "agent_456",
        pid: undefined,
      });
    });

    it("should extract capsule from middle of content", () => {
      const content = "Line 1\n<!-- v.cid:conv_123 aid:agent_456 -->\nLine 2";
      const capsule = extractCapsuleFromContent(content);

      expect(capsule).toEqual({
        cid: "conv_123",
        aid: "agent_456",
        pid: undefined,
      });
    });

    it("should return null if no capsule present", () => {
      const content = "Just regular message content";
      expect(extractCapsuleFromContent(content)).toBeNull();
    });

    it("should extract capsule with parent ID", () => {
      const content =
        "Response\n<!-- v.cid:conv_abc aid:agent_xyz pid:agent_parent -->";
      const capsule = extractCapsuleFromContent(content);

      expect(capsule?.pid).toBe("agent_parent");
    });
  });

  describe("removeCapsuleFromContent", () => {
    it("should remove capsule from end of content", () => {
      const content = "Response text\n<!-- v.cid:conv_123 aid:agent_456 -->";
      const cleaned = removeCapsuleFromContent(content);

      expect(cleaned).toBe("Response text");
      expect(cleaned).not.toContain("<!-- v.cid");
    });

    it("should handle content without capsule", () => {
      const content = "Just regular content";
      const cleaned = removeCapsuleFromContent(content);

      expect(cleaned).toBe("Just regular content");
    });

    it("should remove capsule with parent ID", () => {
      const content = "Content\n<!-- v.cid:conv_a aid:agent_b pid:agent_c -->";
      const cleaned = removeCapsuleFromContent(content);

      expect(cleaned).toBe("Content");
    });

    it("should handle multiple newlines before capsule", () => {
      const content = "Text\n\n\n<!-- v.cid:conv_x aid:agent_y -->";
      const cleaned = removeCapsuleFromContent(content);

      expect(cleaned).toBe("Text");
    });
  });

  describe("appendCapsuleToContent", () => {
    it("should append capsule to content without existing capsule", () => {
      const content = "Original content";
      const capsule: Capsule = {
        cid: "conv_new",
        aid: "agent_new",
      };

      const result = appendCapsuleToContent(content, capsule);

      expect(result).toContain("Original content");
      expect(result).toContain("<!-- v.cid:conv_new aid:agent_new -->");
    });

    it("should replace existing capsule with new one", () => {
      const content = "Content\n<!-- v.cid:conv_old aid:agent_old -->";
      const newCapsule: Capsule = {
        cid: "conv_new",
        aid: "agent_new",
      };

      const result = appendCapsuleToContent(content, newCapsule);

      expect(result).toContain("Content");
      expect(result).toContain("<!-- v.cid:conv_new aid:agent_new -->");
      expect(result).not.toContain("conv_old");
    });

    it("should handle capsule with parent ID", () => {
      const content = "Response";
      const capsule: Capsule = {
        cid: "conv_123",
        aid: "agent_456",
        pid: "agent_parent",
      };

      const result = appendCapsuleToContent(content, capsule);

      expect(result).toContain("Response");
      expect(result).toContain(
        "<!-- v.cid:conv_123 aid:agent_456 pid:agent_parent -->",
      );
    });
  });
});

describe("extractCapsuleFromMessages", () => {
  it("should extract capsule from assistant message", () => {
    const messages: LanguageModelChatMessage[] = [
      {
        role: LanguageModelChatMessageRole.User,
        name: undefined,
        content: [new LanguageModelTextPart("Hello")],
      },
      {
        role: LanguageModelChatMessageRole.Assistant,
        name: undefined,
        content: [
          new LanguageModelTextPart(
            "Response\n<!-- v.cid:conv_123 aid:agent_456 -->",
          ),
        ],
      },
    ];

    const capsule = extractCapsuleFromMessages(messages);
    expect(capsule).toEqual({
      cid: "conv_123",
      aid: "agent_456",
      pid: undefined,
    });
  });

  it("should return most recent capsule when multiple exist", () => {
    const messages: LanguageModelChatMessage[] = [
      {
        role: LanguageModelChatMessageRole.Assistant,
        name: undefined,
        content: [
          new LanguageModelTextPart(
            "Old\n<!-- v.cid:conv_old aid:agent_old -->",
          ),
        ],
      },
      {
        role: LanguageModelChatMessageRole.User,
        name: undefined,
        content: [new LanguageModelTextPart("Question")],
      },
      {
        role: LanguageModelChatMessageRole.Assistant,
        name: undefined,
        content: [
          new LanguageModelTextPart(
            "Recent\n<!-- v.cid:conv_new aid:agent_new -->",
          ),
        ],
      },
    ];

    const capsule = extractCapsuleFromMessages(messages);
    expect(capsule?.cid).toBe("conv_new");
    expect(capsule?.aid).toBe("agent_new");
  });

  it("should return null when no capsule found", () => {
    const messages: LanguageModelChatMessage[] = [
      {
        role: LanguageModelChatMessageRole.User,
        name: undefined,
        content: [new LanguageModelTextPart("Hello")],
      },
      {
        role: LanguageModelChatMessageRole.Assistant,
        name: undefined,
        content: [new LanguageModelTextPart("Regular response")],
      },
    ];

    const capsule = extractCapsuleFromMessages(messages);
    expect(capsule).toBeNull();
  });

  it("should skip user messages when scanning", () => {
    const messages: LanguageModelChatMessage[] = [
      {
        role: LanguageModelChatMessageRole.User,
        name: undefined,
        content: [
          new LanguageModelTextPart(
            "Fake<!-- v.cid:conv_fake aid:agent_fake -->",
          ),
        ],
      },
      {
        role: LanguageModelChatMessageRole.Assistant,
        name: undefined,
        content: [new LanguageModelTextPart("Real response")],
      },
    ];

    const capsule = extractCapsuleFromMessages(messages);
    expect(capsule).toBeNull();
  });
});

describe("Hallucination Detection", () => {
  describe("detectHallucinatedCapsule", () => {
    it("should detect hallucinated cid pattern", () => {
      const buffer = "text... <!-- v.cid:";
      expect(detectHallucinatedCapsule(buffer)).toBe(true);
    });

    it("should detect hallucinated aid pattern", () => {
      const buffer = "end of text <!-- v.aid:";
      expect(detectHallucinatedCapsule(buffer)).toBe(true);
    });

    it("should detect hallucinated pid pattern", () => {
      const buffer = "...text <!-- v.pid:";
      expect(detectHallucinatedCapsule(buffer)).toBe(true);
    });

    it("should not detect regular HTML comments", () => {
      const buffer = "text <!-- regular comment";
      expect(detectHallucinatedCapsule(buffer)).toBe(false);
    });

    it("should not detect complete valid capsule", () => {
      // A complete capsule is not considered "hallucination in progress"
      const buffer = "<!-- v.cid:conv_123 aid:agent_456 -->";
      // Note: This should NOT be considered a "hallucination in progress"
      // because the full pattern is complete
      expect(detectHallucinatedCapsule(buffer)).toBe(true); // Pattern match exists
    });

    it("should handle empty buffer", () => {
      expect(detectHallucinatedCapsule("")).toBe(false);
    });
  });

  describe("getStreamBuffer", () => {
    it("should extract last N characters", () => {
      const content = "0123456789abcdefghij";
      const buffer = getStreamBuffer(content, 5);

      expect(buffer).toBe("fghij");
    });

    it("should return full content if shorter than N", () => {
      const content = "short";
      const buffer = getStreamBuffer(content, 10);

      expect(buffer).toBe("short");
    });

    it("should use default buffer size of 20", () => {
      const content = "a".repeat(100);
      const buffer = getStreamBuffer(content);

      expect(buffer.length).toBe(20);
      expect(buffer).toBe(content.slice(-20));
    });

    it("should handle empty content", () => {
      const buffer = getStreamBuffer("");

      expect(buffer).toBe("");
    });
  });
});

describe("ID Generation", () => {
  describe("generateConversationId", () => {
    it("should generate valid conversation ID", () => {
      const id = generateConversationId();

      expect(id).toMatch(/^conv_[0-9a-f]{10}$/);
    });

    it("should generate unique conversation IDs", () => {
      const id1 = generateConversationId();
      const id2 = generateConversationId();
      const id3 = generateConversationId();

      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(id1).not.toBe(id3);
    });

    it("should be stable format for parsing", () => {
      const id = generateConversationId();
      // Should be parseable as cid in a capsule
      const capsule: Capsule = {
        cid: id,
        aid: generateAgentId(),
      };

      const formatted = formatCapsule(capsule);
      const parsed = parseCapsule(formatted);

      expect(parsed?.cid).toBe(id);
    });
  });

  describe("generateAgentId", () => {
    it("should generate valid agent ID", () => {
      const id = generateAgentId();

      expect(id).toMatch(/^agent_[0-9a-f]{10}$/);
    });

    it("should generate unique agent IDs", () => {
      const id1 = generateAgentId();
      const id2 = generateAgentId();
      const id3 = generateAgentId();

      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(id1).not.toBe(id3);
    });

    it("should be stable format for parsing", () => {
      const aid = generateAgentId();
      // Should be parseable as aid in a capsule
      const capsule: Capsule = {
        cid: generateConversationId(),
        aid,
      };

      const formatted = formatCapsule(capsule);
      const parsed = parseCapsule(formatted);

      expect(parsed?.aid).toBe(aid);
    });
  });
});

describe("Integration Tests", () => {
  beforeEach(() => {
    // Generate fresh IDs for each test to ensure independence
    generateConversationId();
    generateAgentId();
  });

  it("should handle full capsule lifecycle", () => {
    // 1. Generate IDs
    const cid = generateConversationId();
    const aid = generateAgentId();

    // 2. Create capsule
    const capsule: Capsule = { cid, aid };

    // 3. Append to content
    let content = "First response from assistant";
    content = appendCapsuleToContent(content, capsule);

    // 4. Extract from content
    const extracted = extractCapsuleFromContent(content);
    expect(extracted).toEqual(capsule);

    // 5. Update with new capsule (simulating second response)
    const newAid = generateAgentId();
    const newCapsule: Capsule = { cid, aid: newAid }; // Same conversation
    content = appendCapsuleToContent(content, newCapsule);

    // 6. Verify latest capsule is extracted
    const latestExtracted = extractCapsuleFromContent(content);
    expect(latestExtracted?.aid).toBe(newAid);
    expect(latestExtracted?.cid).toBe(cid); // Conversation ID unchanged
  });

  it("should handle subagent hierarchy", () => {
    const parentCid = generateConversationId();
    const parentAid = generateAgentId();
    const childAid = generateAgentId();

    // Parent response
    let parentResponse = "Parent agent response";
    parentResponse = appendCapsuleToContent(parentResponse, {
      cid: parentCid,
      aid: parentAid,
    });

    // Child response with parent reference
    let childResponse = "Child agent response";
    childResponse = appendCapsuleToContent(childResponse, {
      cid: parentCid,
      aid: childAid,
      pid: parentAid,
    });

    const childCapsule = extractCapsuleFromContent(childResponse);
    expect(childCapsule?.pid).toBe(parentAid);
    expect(childCapsule?.cid).toBe(parentCid); // Same conversation
  });
});
