/**
 * Tests for system prompt extraction functions.
 */

import { describe, expect, it, vi } from "vitest";

// Create hoisted mock for vscode module
const hoisted = vi.hoisted(() => {
  class MockLanguageModelTextPart {
    value: string;
    constructor(value: string) {
      this.value = value;
    }
  }

  class MockLanguageModelChatMessage {
    role: number;
    content: unknown[];
    name: string | undefined;

    static User(
      content: string | unknown[],
      name?: string,
    ): MockLanguageModelChatMessage {
      const msg = new MockLanguageModelChatMessage(1, content, name);
      return msg;
    }

    static Assistant(
      content: string | unknown[],
      name?: string,
    ): MockLanguageModelChatMessage {
      const msg = new MockLanguageModelChatMessage(2, content, name);
      return msg;
    }

    static System(
      content: string | unknown[],
      name?: string,
    ): MockLanguageModelChatMessage {
      const msg = new MockLanguageModelChatMessage(3, content, name);
      return msg;
    }

    constructor(role: number, content: string | unknown[], name?: string) {
      this.role = role;
      this.content =
        typeof content === "string"
          ? [new MockLanguageModelTextPart(content)]
          : content;
      this.name = name;
    }
  }

  const MockLanguageModelChatMessageRole = {
    User: 1,
    Assistant: 2,
  };

  return {
    MockLanguageModelTextPart,
    MockLanguageModelChatMessage,
    MockLanguageModelChatMessageRole,
  };
});

// Set up mock before importing modules
vi.mock("vscode", () => ({
  LanguageModelChatMessageRole: hoisted.MockLanguageModelChatMessageRole,
  LanguageModelTextPart: hoisted.MockLanguageModelTextPart,
  LanguageModelChatMessage: hoisted.MockLanguageModelChatMessage,
}));

// Mock the logger to avoid side effects
vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

import {
  VSCODE_SYSTEM_ROLE,
  extractSystemPrompt,
  extractMessageText,
  extractDisguisedSystemPrompt,
} from "./system-prompt.js";
import type { LanguageModelChatMessage } from "vscode";

const { MockLanguageModelChatMessage, MockLanguageModelTextPart } = hoisted;

// Type helpers to avoid `as any` while keeping test readability
// The mock classes implement the same interface as the real VS Code classes
type MockMessage = InstanceType<typeof MockLanguageModelChatMessage>;
const asMessage = (m: MockMessage) => m as unknown as LanguageModelChatMessage;
const asMessages = (m: MockMessage[]) =>
  m as unknown as readonly LanguageModelChatMessage[];

describe("system-prompt", () => {
  describe("VSCODE_SYSTEM_ROLE", () => {
    it("should be 3 (proposed API value)", () => {
      expect(VSCODE_SYSTEM_ROLE).toBe(3);
    });
  });

  describe("extractSystemPrompt", () => {
    it("canary: stays exported and callable", () => {
      // Canary test to prevent accidental removal or signature changes.
      expect(typeof extractSystemPrompt).toBe("function");
      expect(extractSystemPrompt([])).toBeUndefined();
    });

    it("should return undefined for empty messages array", () => {
      expect(extractSystemPrompt([])).toBeUndefined();
    });

    it("should extract text from role=3 (System) message", () => {
      const messages = [
        MockLanguageModelChatMessage.System("You are a helpful assistant."),
      ];
      const result = extractSystemPrompt(asMessages(messages));
      expect(result).toBe("You are a helpful assistant.");
    });

    it("should return undefined for User role message", () => {
      const messages = [MockLanguageModelChatMessage.User("Hello")];
      const result = extractSystemPrompt(asMessages(messages));
      expect(result).toBeUndefined();
    });

    it("should delegate to extractDisguisedSystemPrompt for Assistant role with system pattern", () => {
      const messages = [
        MockLanguageModelChatMessage.Assistant(
          "You are a helpful coding assistant.",
        ),
      ];
      const result = extractSystemPrompt(asMessages(messages));
      expect(result).toBe("You are a helpful coding assistant.");
    });

    it("should return undefined for Assistant role without system pattern", () => {
      const messages = [
        MockLanguageModelChatMessage.Assistant("Hello, how can I help you?"),
      ];
      const result = extractSystemPrompt(asMessages(messages));
      expect(result).toBeUndefined();
    });

    it("should handle messages with multiple text parts", () => {
      const messages = [
        new MockLanguageModelChatMessage(3, [
          new MockLanguageModelTextPart("Part one. "),
          new MockLanguageModelTextPart("Part two."),
        ]),
      ];
      const result = extractSystemPrompt(asMessages(messages));
      expect(result).toBe("Part one. Part two.");
    });
  });

  describe("extractMessageText", () => {
    it("should extract text from array content", () => {
      const message = MockLanguageModelChatMessage.User("Hello world");
      const result = extractMessageText(asMessage(message));
      expect(result).toBe("Hello world");
    });

    it("should concatenate multiple text parts", () => {
      const message = new MockLanguageModelChatMessage(1, [
        new MockLanguageModelTextPart("Hello "),
        new MockLanguageModelTextPart("world"),
      ]);
      const result = extractMessageText(asMessage(message));
      expect(result).toBe("Hello world");
    });

    it("should return undefined for empty content", () => {
      const message = new MockLanguageModelChatMessage(1, []);
      const result = extractMessageText(asMessage(message));
      expect(result).toBeUndefined();
    });

    it("should trim whitespace", () => {
      const message = MockLanguageModelChatMessage.User("  trimmed  ");
      const result = extractMessageText(asMessage(message));
      expect(result).toBe("trimmed");
    });

    it("should return undefined for whitespace-only content", () => {
      const message = MockLanguageModelChatMessage.User("   ");
      const result = extractMessageText(asMessage(message));
      expect(result).toBeUndefined();
    });
  });

  describe("extractDisguisedSystemPrompt", () => {
    it("should detect 'You are a' pattern", () => {
      const message = MockLanguageModelChatMessage.Assistant(
        "You are a helpful assistant.",
      );
      const result = extractDisguisedSystemPrompt(asMessage(message));
      expect(result).toBe("You are a helpful assistant.");
    });

    it("should detect 'You are an' pattern", () => {
      const message = MockLanguageModelChatMessage.Assistant(
        "You are an expert programmer.",
      );
      const result = extractDisguisedSystemPrompt(asMessage(message));
      expect(result).toBe("You are an expert programmer.");
    });

    it("should detect '<instructions>' pattern", () => {
      const message = MockLanguageModelChatMessage.Assistant(
        "<instructions>Follow these rules...</instructions>",
      );
      const result = extractDisguisedSystemPrompt(asMessage(message));
      expect(result).toBe("<instructions>Follow these rules...</instructions>");
    });

    it("should detect '<system>' pattern", () => {
      const message = MockLanguageModelChatMessage.Assistant(
        "<system>You are helpful.</system>",
      );
      const result = extractDisguisedSystemPrompt(asMessage(message));
      expect(result).toBe("<system>You are helpful.</system>");
    });

    it("should detect 'As an AI' pattern", () => {
      const message = MockLanguageModelChatMessage.Assistant(
        "As an AI assistant, I will help you.",
      );
      const result = extractDisguisedSystemPrompt(asMessage(message));
      expect(result).toBe("As an AI assistant, I will help you.");
    });

    it("should detect 'Your role is' pattern", () => {
      const message = MockLanguageModelChatMessage.Assistant(
        "Your role is to assist with coding.",
      );
      const result = extractDisguisedSystemPrompt(asMessage(message));
      expect(result).toBe("Your role is to assist with coding.");
    });

    it('should detect "You\'re a" pattern', () => {
      const message = MockLanguageModelChatMessage.Assistant(
        "You're a coding expert.",
      );
      const result = extractDisguisedSystemPrompt(asMessage(message));
      expect(result).toBe("You're a coding expert.");
    });

    it("should return undefined for normal messages", () => {
      const message = MockLanguageModelChatMessage.Assistant(
        "Hello, how can I help you today?",
      );
      const result = extractDisguisedSystemPrompt(asMessage(message));
      expect(result).toBeUndefined();
    });

    it("should detect long messages with >=2 instruction keywords", () => {
      const longMessage =
        "x".repeat(1001) + " follow the user and you must help them";
      const message = MockLanguageModelChatMessage.Assistant(longMessage);
      const result = extractDisguisedSystemPrompt(asMessage(message));
      expect(result).toBe(longMessage);
    });

    it("should not trigger on short messages with keywords", () => {
      const shortMessage = "follow the user and you must help";
      const message = MockLanguageModelChatMessage.Assistant(shortMessage);
      const result = extractDisguisedSystemPrompt(asMessage(message));
      expect(result).toBeUndefined();
    });

    it("should not trigger on long messages with <2 keywords", () => {
      const longMessage = "x".repeat(1001) + " follow the user";
      const message = MockLanguageModelChatMessage.Assistant(longMessage);
      const result = extractDisguisedSystemPrompt(asMessage(message));
      expect(result).toBeUndefined();
    });

    it("should return undefined for empty message", () => {
      const message = MockLanguageModelChatMessage.Assistant("");
      const result = extractDisguisedSystemPrompt(asMessage(message));
      expect(result).toBeUndefined();
    });
  });
});
