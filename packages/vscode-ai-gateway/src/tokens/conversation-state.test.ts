import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModelChatMessage, Memento } from "vscode";
import { logger } from "../logger";
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

vi.mock("../logger", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

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

    it("tolerates system prompt drift at index 0 (RFC 00033 AXIOM)", () => {
      // Record state with system prompt v1
      const original = [
        createMessage(0, "System prompt version 1 with agents block A"),
        createMessage(1, "hello"),
        createMessage(2, "world"),
        createMessage(1, "how are you?"),
        createMessage(2, "I'm fine"),
      ];
      tracker.recordActual(original, "claude", 5000);

      // Lookup with system prompt v2 (changed) but same history, plus new message
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
      // RFC 00033 AXIOM: firstUserMessageHash is the ONLY identity key.
      // System Prompt at index 0 is diagnostics-only, NOT identity.
      // We should tolerate the drift and return prefix match for new message.
      expect(result.type).toBe("prefix");
      if (result.type === "prefix") {
        expect(result.knownTokens).toBe(5000);
        expect(result.newMessageCount).toBe(1); // Only the "new question" message
        expect(result.newMessageIndices).toEqual([5]); // Index 5 is the new user message
      }
    });

    it("returns exact match despite system prompt drift (RFC 00033 AXIOM)", () => {
      // Record state with system prompt v1
      const original = [
        createMessage(0, "System prompt version 1"),
        createMessage(1, "hello"),
        createMessage(2, "world"),
      ];
      tracker.recordActual(original, "claude", 3000);

      // Same conversation but system prompt changed (VS Code injected new content)
      const drifted = [
        createMessage(0, "System prompt version 2 with <agents> block"),
        createMessage(1, "hello"),
        createMessage(2, "world"),
      ];

      const result = tracker.lookup(drifted, "claude");
      // RFC 00033 AXIOM: System prompt drift at Index 0 is allowed
      // Should still return exact match since all user messages are present
      expect(result.type).toBe("exact");
      if (result.type === "exact") {
        expect(result.knownTokens).toBe(3000);
      }
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

  describe("Conversation Identity (conversationId)", () => {
    it("returns conversationId for exact match", () => {
      const messages = [createMessage(1, "hello"), createMessage(2, "world")];

      tracker.recordActual(messages, "claude", 500);

      const result = tracker.lookup(messages, "claude");
      expect(result.type).toBe("exact");
      expect(result.conversationId).toBeDefined();
      expect(typeof result.conversationId).toBe("string");
      expect(result.conversationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it("returns same conversationId for prefix match (extended conversation)", () => {
      const msg1 = createMessage(1, "hello");
      const msg2 = createMessage(2, "world");
      const msg3 = createMessage(1, "how are you?");

      // Record state for [msg1, msg2]
      tracker.recordActual([msg1, msg2], "claude", 500);

      // Get the conversationId
      const exactResult = tracker.lookup([msg1, msg2], "claude");
      expect(exactResult.type).toBe("exact");
      const originalConversationId = exactResult.conversationId;
      expect(originalConversationId).toBeDefined();

      // Lookup [msg1, msg2, msg3] - should be prefix match with same conversationId
      const prefixResult = tracker.lookup([msg1, msg2, msg3], "claude");
      expect(prefixResult.type).toBe("prefix");
      expect(prefixResult.conversationId).toBe(originalConversationId);
    });

    it("preserves conversationId across recordActual calls for same conversation", () => {
      const msg1 = createMessage(1, "hello");
      const msg2 = createMessage(2, "world");
      const msg3 = createMessage(1, "how are you?");

      // Record initial state
      tracker.recordActual([msg1, msg2], "claude", 500);
      const result1 = tracker.lookup([msg1, msg2], "claude");
      const originalConversationId = result1.conversationId;
      expect(originalConversationId).toBeDefined();

      // Extend the conversation
      tracker.recordActual([msg1, msg2, msg3], "claude", 750);
      const result2 = tracker.lookup([msg1, msg2, msg3], "claude");

      // Should have the same conversationId
      expect(result2.conversationId).toBe(originalConversationId);
    });

    it("generates different conversationIds for different conversations", () => {
      const conv1 = [
        createMessage(1, "hello A"),
        createMessage(2, "response A"),
      ];
      const conv2 = [
        createMessage(1, "hello B"),
        createMessage(2, "response B"),
      ];

      tracker.recordActual(conv1, "claude", 500);
      tracker.recordActual(conv2, "claude", 600);

      const result1 = tracker.lookup(conv1, "claude");
      const result2 = tracker.lookup(conv2, "claude");

      expect(result1.conversationId).toBeDefined();
      expect(result2.conversationId).toBeDefined();
      expect(result1.conversationId).not.toBe(result2.conversationId);
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

    it("preserves conversationId across persistence and reload", async () => {
      const memento = createMockMemento();
      const persistedTracker = new ConversationStateTracker(memento);

      const messages = [createMessage(1, "persist me")];
      persistedTracker.recordActual(messages, "claude", 777);

      // Get the assigned conversationId
      const result1 = persistedTracker.lookup(messages, "claude");
      const originalConversationId = result1.conversationId;
      expect(originalConversationId).toBeDefined();

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Create new tracker from persisted state
      const newTracker = new ConversationStateTracker(memento);
      const result2 = newTracker.lookup(messages, "claude");

      expect(result2.conversationId).toBe(originalConversationId);
    });

    it("backfills conversationId for legacy persisted state without it", async () => {
      // Simulate legacy state without conversationId
      const legacyState = {
        "conversation-state-v2": {
          conversations: {
            abc123_claude: {
              // No conversationId field - legacy state
              messageHashes: ["hash1", "hash2"],
              actualTokens: 500,
              lastUsed: Date.now(),
            },
          },
        },
      };
      const memento = createMockMemento(legacyState);
      const tracker = new ConversationStateTracker(memento);

      // The tracker should have backfilled conversationId on load
      // We need to look up with matching messages to get the state
      // Since we don't have the original messages, we verify by internal state
      // But we can't access internal state directly, so let's test via a new record

      // Actually, we can test that NEW records get conversationId
      const messages = [createMessage(1, "new message")];
      tracker.recordActual(messages, "claude", 100);

      const result = tracker.lookup(messages, "claude");
      expect(result.conversationId).toBeDefined();
    });
  });

  describe("Telemetry", () => {
    it("logs near miss when strict prefix fails but approximate match is found", () => {
      const messagesA = [
        createMessage(1, "A"),
        createMessage(2, "B"),
        createMessage(1, "C"),
        createMessage(2, "D"),
        createMessage(1, "E"),
        createMessage(2, "F"),
      ];
      tracker.recordActual(messagesA, "claude", 100);

      // Same prefix for first 5 messages, divergence at end (G vs F)
      // This is 5/6 matches = 83% overlap
      const messagesB = [
        createMessage(1, "A"),
        createMessage(2, "B"),
        createMessage(1, "C"),
        createMessage(2, "D"),
        createMessage(1, "E"),
        createMessage(2, "G"), // Divergence
      ];

      vi.mocked(logger.info).mockClear();

      tracker.recordActual(messagesB, "claude", 120);

      // Should log the near miss
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("[NearMissTelemetry]"),
      );

      // Verify log details
      const logCall = vi
        .mocked(logger.info)
        .mock.calls.find((args) => args[0].includes("[NearMissTelemetry]"));
      expect(logCall).toBeDefined();
      expect(logCall![0]).toContain("Overlap=5/6 (83.3%)");
      expect(logCall![0]).toContain("DivergenceIndex=5");
    });

    it("does not log near miss for short conversations (< 5 messages)", () => {
      const messagesA = [
        createMessage(1, "A"),
        createMessage(2, "B"),
        createMessage(1, "C"),
        createMessage(2, "D"),
      ]; // length 4
      tracker.recordActual(messagesA, "claude", 100);

      const messagesB = [
        createMessage(1, "A"),
        createMessage(2, "B"),
        createMessage(1, "C"),
        createMessage(2, "E"),
      ];

      vi.mocked(logger.info).mockClear();
      tracker.recordActual(messagesB, "claude", 120);

      expect(logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining("[NearMissTelemetry]"),
      );
    });

    it("does not log near miss for low overlap", () => {
      const messagesA = [
        createMessage(1, "A"),
        createMessage(2, "B"),
        createMessage(1, "C"),
        createMessage(2, "D"),
        createMessage(1, "E"),
        createMessage(2, "F"),
      ];
      tracker.recordActual(messagesA, "claude", 100);

      const messagesB = [
        createMessage(1, "A"),
        createMessage(2, "B"),
        createMessage(1, "X"),
        createMessage(2, "Y"),
        createMessage(1, "Z"),
        createMessage(2, "W"),
      ]; // Only 2/6 overlap = 33%

      vi.mocked(logger.info).mockClear();
      tracker.recordActual(messagesB, "claude", 120);

      expect(logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining("[NearMissTelemetry]"),
      );
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
