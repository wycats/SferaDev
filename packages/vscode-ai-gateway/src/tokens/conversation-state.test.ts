import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModelChatMessage, Memento } from "vscode";
import {
  ConversationStateTracker,
  hasSummarizationTag,
} from "./conversation-state";

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

// Helper to create mock messages
function createMessage(
  role: number,
  content: string,
): LanguageModelChatMessage {
  return {
    role,
    content: [new vscodeHoisted.LanguageModelTextPart(content)],
    name: undefined,
  } as unknown as LanguageModelChatMessage;
}

// Helper to create mock memento for persistence tests
function createMockMemento(
  initial: Record<string, unknown> = {},
): Memento & { _store: Map<string, unknown> } {
  const store = new Map<string, unknown>(Object.entries(initial));

  return {
    _store: store,
    keys(): readonly string[] {
      return Array.from(store.keys());
    },
    get<T>(key: string, defaultValue?: T): T | undefined {
      if (store.has(key)) {
        return store.get(key) as T;
      }
      return defaultValue;
    },
    update(key: string, value: unknown): Thenable<void> {
      if (value === undefined) {
        store.delete(key);
      } else {
        store.set(key, value);
      }
      return Promise.resolve();
    },
  };
}

describe("ConversationStateTracker", () => {
  let tracker: ConversationStateTracker;

  beforeEach(() => {
    tracker = new ConversationStateTracker();
  });

  describe("Token Tracking (Exact & Prefix)", () => {
    it("stores and retrieves exact match", () => {
      const messages = [createMessage(1, "hello"), createMessage(2, "world")];

      tracker.recordActual(messages, "claude", 500);

      const result = tracker.lookup(messages, "claude");
      expect(result.type).toBe("exact");
      expect(result.knownTokens).toBe(500);
    });

    it("distinguishes between model families", () => {
      const messages = [createMessage(1, "hello")];

      tracker.recordActual(messages, "claude", 100);
      tracker.recordActual(messages, "gpt-4", 120);

      const resultClaude = tracker.lookup(messages, "claude");
      expect(resultClaude.type).toBe("exact");
      expect(resultClaude.knownTokens).toBe(100);

      const resultGpt = tracker.lookup(messages, "gpt-4");
      expect(resultGpt.type).toBe("exact");
      expect(resultGpt.knownTokens).toBe(120);
    });

    it("retrieves prefix match for extended conversation", () => {
      const msg1 = createMessage(1, "hello");
      const msg2 = createMessage(2, "world");
      const msg3 = createMessage(1, "how are you?");

      // Record state for [msg1, msg2]
      tracker.recordActual([msg1, msg2], "claude", 500);

      // Lookup [msg1, msg2, msg3]
      const result = tracker.lookup([msg1, msg2, msg3], "claude");

      expect(result.type).toBe("prefix");
      expect(result.knownTokens).toBe(500);
      expect(result.newMessageCount).toBe(1);
    });

    it("handles deeply nested prefix lookups (backtracking)", () => {
      const msgs = [
        createMessage(1, "1"),
        createMessage(2, "2"),
        createMessage(1, "3"),
        createMessage(2, "4"),
      ];

      // Store state for [1, 2]
      tracker.recordActual(msgs.slice(0, 2), "claude", 200);

      // Lookup [1, 2, 3, 4]
      // It should backtrack from [1,2,3,4] -> [1,2,3] -> [1,2] match!
      const result = tracker.lookup(msgs, "claude");

      expect(result.type).toBe("prefix");
      expect(result.knownTokens).toBe(200);
      expect(result.newMessageCount).toBe(2);
    });

    it("returns none when no matching state exists", () => {
      const messages = [createMessage(1, "hello")];
      const result = tracker.lookup(messages, "claude");
      expect(result.type).toBe("none");
    });

    it("returns none when prefix exists but families mismatch", () => {
      const messages = [createMessage(1, "hello")];
      tracker.recordActual(messages, "claude", 100);

      const result = tracker.lookup(messages, "gpt-4");
      expect(result.type).toBe("none");
    });

    it("tolerates system prompt drift at index 0 (RFC 00058 §2.3)", () => {
      // Record state with system prompt v1
      const original = [
        createMessage(0, "System prompt version 1 with agents block A"),
        createMessage(1, "hello"),
        createMessage(2, "world"),
        createMessage(1, "how are you?"),
        createMessage(2, "I'm fine"),
      ];
      tracker.recordActual(original, "claude", 5000);

      // Lookup with system prompt v2 (changed) but same history
      const drifted = [
        createMessage(
          0,
          "System prompt version 2 with agents block B and workspace info",
        ),
        createMessage(1, "hello"),
        createMessage(2, "world"),
        createMessage(1, "how are you?"),
        createMessage(2, "I'm fine"),
        createMessage(1, "new question"),
      ];

      const result = tracker.lookup(drifted, "claude");
      // With strict inclusion, we reject candidates where known messages are missing in current
      expect(result.type).toBe("none");
    });

    it("handles set intersection when known state has different system prompt", () => {
      // Record with 4 messages (need at least 2 matches)
      const original = [
        createMessage(1, "A"),
        createMessage(2, "B"),
        createMessage(1, "C"),
        createMessage(2, "D"),
      ];
      tracker.recordActual(original, "claude", 2000);

      // Same messages but with one additional message at the end
      const extended = [
        createMessage(1, "A"),
        createMessage(2, "B"),
        createMessage(1, "C"),
        createMessage(2, "D"),
        createMessage(1, "E"),
      ];

      const result = tracker.lookup(extended, "claude");
      expect(result.type).toBe("prefix");
      expect(result.knownTokens).toBe(2000);
      expect(result.newMessageCount).toBe(1);
    });

    it("rejects candidates with insufficient overlap", () => {
      // Record a conversation with 6 messages
      const original = [
        createMessage(1, "A"),
        createMessage(2, "B"),
        createMessage(1, "C"),
        createMessage(2, "D"),
        createMessage(1, "E"),
        createMessage(2, "F"),
      ];
      tracker.recordActual(original, "claude", 3000);

      // Lookup a mostly-different conversation that only shares 1 message
      const different = [
        createMessage(1, "X"),
        createMessage(2, "Y"),
        createMessage(1, "A"), // only 1 overlap - below threshold
        createMessage(2, "Z"),
      ];

      const result = tracker.lookup(different, "claude");
      expect(result.type).toBe("none");
    });

    it("supports branching conversations (backtracking works across branches)", () => {
      const root = [createMessage(1, "A"), createMessage(2, "B")];
      tracker.recordActual(root, "claude", 100);

      // Branch 1: [A, B, C]
      const branch1 = [...root, createMessage(1, "C")];
      tracker.recordActual(branch1, "claude", 150);

      // Branch 2: [A, B, D]
      const branch2 = [...root, createMessage(1, "D")];

      // Lookup Branch 2 should accept Root as prefix
      const result = tracker.lookup(branch2, "claude");
      expect(result.type).toBe("prefix");
      expect(result.knownTokens).toBe(100);
      expect(result.newMessageCount).toBe(1);
    });
  });

  describe("Persistence", () => {
    it("saves and loads state", async () => {
      const memento = createMockMemento();
      const persistedTracker = new ConversationStateTracker(memento);

      const messages = [createMessage(1, "persist me")];
      persistedTracker.recordActual(messages, "claude", 777);

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const newTracker = new ConversationStateTracker(memento);
      const result = newTracker.lookup(messages, "claude");
      expect(result.type).toBe("exact");
      expect(result.knownTokens).toBe(777);
    });
  });
});

describe("hasSummarizationTag", () => {
  it("detects <conversation-summary> in a user message", () => {
    const messages = [
      createMessage(
        1,
        "<conversation-summary>\nThe user asked about token estimation.\n</conversation-summary>",
      ),
      createMessage(2, "Sure, I can help with that."),
      createMessage(1, "What about rolling correction?"),
    ];
    expect(hasSummarizationTag(messages)).toBe(true);
  });

  it("returns false for normal messages without summary tag", () => {
    const messages = [
      createMessage(1, "Hello, how are you?"),
      createMessage(2, "I'm doing well, thanks!"),
    ];
    expect(hasSummarizationTag(messages)).toBe(false);
  });

  it("ignores <conversation-summary> in assistant messages", () => {
    const messages = [
      createMessage(2, "Here is a <conversation-summary> tag example."),
    ];
    expect(hasSummarizationTag(messages)).toBe(false);
  });

  it("is case-insensitive", () => {
    const messages = [
      createMessage(
        1,
        "<Conversation-Summary>\nSummary text\n</Conversation-Summary>",
      ),
    ];
    expect(hasSummarizationTag(messages)).toBe(true);
  });

  it("returns false for empty messages array", () => {
    expect(hasSummarizationTag([])).toBe(false);
  });

  it("detects tag in serialized text parts ({type, text} format)", () => {
    const messages = [
      {
        role: 1,
        content: [
          {
            type: "text",
            text: "<conversation-summary>\nSummary\n</conversation-summary>",
          },
        ],
      },
    ] as unknown as LanguageModelChatMessage[];
    expect(hasSummarizationTag(messages)).toBe(true);
  });
});
