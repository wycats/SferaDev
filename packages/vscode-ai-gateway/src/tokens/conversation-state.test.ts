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

  describe("recordActual", () => {
    it("stores conversation state", () => {
      const messages = [createMessage(1, "hello"), createMessage(2, "world")];

      tracker.recordActual(messages, "claude", 500);

      const state = tracker.getState("claude");
      expect(state).toBeDefined();
      expect(state?.actualTokens).toBe(500);
      expect(state?.messageHashes).toHaveLength(2);
      expect(state?.modelFamily).toBe("claude");
    });

    it("tracks different model families separately", () => {
      const messages = [createMessage(1, "hello")];

      tracker.recordActual(messages, "claude", 100);
      tracker.recordActual(messages, "gpt-4", 120);

      expect(tracker.getState("claude")?.actualTokens).toBe(100);
      expect(tracker.getState("gpt-4")?.actualTokens).toBe(120);
    });

    it("overwrites previous state for same model", () => {
      const messages1 = [createMessage(1, "first")];
      const messages2 = [createMessage(1, "second")];

      tracker.recordActual(messages1, "claude", 100);
      tracker.recordActual(messages2, "claude", 200);

      expect(tracker.getState("claude")?.actualTokens).toBe(200);
    });
  });

  // NOTE: "conversation isolation" describe block deleted - zombie tests (RFC 00054)
  // Per-conversation keying removed in favor of family-only keying.
  // The "falls back to model-only key" test is now the default behavior.

  describe("model-family keying", () => {
    it("uses model-family as key", () => {
      const messages = [createMessage(1, "hello")];

      tracker.recordActual(messages, "claude", 100);

      const state = tracker.getState("claude");
      expect(state?.actualTokens).toBe(100);

      const result = tracker.lookup(messages, "claude");
      expect(result.type).toBe("exact");
      expect(result.knownTokens).toBe(100);
    });
  });

  describe("lookup", () => {
    describe("no match", () => {
      it("returns none when no state exists", () => {
        const messages = [createMessage(1, "hello")];

        const result = tracker.lookup(messages, "claude");

        expect(result.type).toBe("none");
        expect(result.knownTokens).toBeUndefined();
      });

      it("returns none when messages diverge from known state", () => {
        const messages1 = [
          createMessage(1, "hello"),
          createMessage(2, "world"),
        ];
        const messages2 = [
          createMessage(1, "different"),
          createMessage(2, "conversation"),
        ];

        tracker.recordActual(messages1, "claude", 500);

        const result = tracker.lookup(messages2, "claude");

        expect(result.type).toBe("none");
      });

      it("returns none when messages are shorter than known state", () => {
        const messages1 = [
          createMessage(1, "hello"),
          createMessage(2, "world"),
        ];
        const messages2 = [createMessage(1, "hello")];

        tracker.recordActual(messages1, "claude", 500);

        const result = tracker.lookup(messages2, "claude");

        expect(result.type).toBe("none");
      });
    });

    describe("exact match", () => {
      it("returns exact when messages match exactly", () => {
        const messages = [createMessage(1, "hello"), createMessage(2, "world")];

        tracker.recordActual(messages, "claude", 500);

        const result = tracker.lookup(messages, "claude");

        expect(result.type).toBe("exact");
        expect(result.knownTokens).toBe(500);
      });

      it("matches based on content hash, not object identity", () => {
        const messages1 = [createMessage(1, "hello")];
        const messages2 = [createMessage(1, "hello")]; // Same content, different object

        tracker.recordActual(messages1, "claude", 100);

        const result = tracker.lookup(messages2, "claude");

        expect(result.type).toBe("exact");
        expect(result.knownTokens).toBe(100);
      });
    });

    describe("prefix match", () => {
      it("returns prefix when conversation extends known state", () => {
        const messages1 = [
          createMessage(1, "hello"),
          createMessage(2, "world"),
        ];

        tracker.recordActual(messages1, "claude", 500);

        const messages2 = [...messages1, createMessage(1, "new message")];

        const result = tracker.lookup(messages2, "claude");

        expect(result.type).toBe("prefix");
        expect(result.knownTokens).toBe(500);
        expect(result.newMessageCount).toBe(1);
        expect(result.newMessageIndices).toEqual([2]);
      });

      it("handles multiple new messages", () => {
        const messages1 = [createMessage(1, "hello")];

        tracker.recordActual(messages1, "claude", 100);

        const messages2 = [
          ...messages1,
          createMessage(2, "response"),
          createMessage(1, "follow up"),
        ];

        const result = tracker.lookup(messages2, "claude");

        expect(result.type).toBe("prefix");
        expect(result.newMessageCount).toBe(2);
        expect(result.newMessageIndices).toEqual([1, 2]);
      });
    });
  });

  describe("clear", () => {
    it("removes all state", () => {
      const messages = [createMessage(1, "hello")];

      tracker.recordActual(messages, "claude", 100);
      tracker.recordActual(messages, "gpt-4", 120);

      tracker.clear();

      expect(tracker.getState("claude")).toBeUndefined();
      expect(tracker.getState("gpt-4")).toBeUndefined();
    });
  });

  describe("memory leak protections", () => {
    it("evicts least recently used entries when max size is reached", () => {
      // With family-only keying, each unique modelFamily gets one entry
      // Fill to capacity with different model families
      for (let i = 0; i < 100; i += 1) {
        tracker.recordActual(
          [createMessage(1, `msg-${i.toString()}`)],
          `model-${i.toString()}`,
          i,
        );
      }

      expect(tracker.size()).toBe(100);
      expect(tracker.getState("model-0")).toBeDefined();

      // Add one more family - should evict oldest
      tracker.recordActual([createMessage(1, "msg-100")], "model-100", 100);

      // model-0 should be evicted (oldest)
      expect(tracker.getState("model-0")).toBeUndefined();
      expect(tracker.getState("model-100")).toBeDefined();
    });

    it("preserves recently used entries in LRU eviction", () => {
      for (let i = 0; i < 100; i += 1) {
        tracker.recordActual(
          [createMessage(1, `msg-${i.toString()}`)],
          `model-${i.toString()}`,
          i,
        );
      }

      // Touch model-0 to make it recently used
      const lookup = tracker.lookup([createMessage(1, "msg-0")], "model-0");
      expect(lookup.type).toBe("exact");

      // Add new entry
      tracker.recordActual([createMessage(1, "msg-100")], "model-100", 100);

      // model-0 was recently touched, so model-1 should be evicted instead
      expect(tracker.getState("model-0")).toBeDefined();
      expect(tracker.getState("model-1")).toBeUndefined();
    });

    it("does not exceed maxEntries when new model family is introduced at capacity", () => {
      // Fill to capacity with different model families
      for (let i = 0; i < 100; i += 1) {
        tracker.recordActual(
          [createMessage(1, `msg-${i.toString()}`)],
          `model-${i.toString()}`,
          i,
        );
      }
      expect(tracker.size()).toBe(100);

      // Introduce a new model family — should evict to stay at 100
      tracker.recordActual([createMessage(1, "gpt-msg")], "gpt-4", 999);

      expect(tracker.size()).toBeLessThanOrEqual(100);
      expect(tracker.getState("gpt-4")).toBeDefined();
    });

    it("cleans up stale entries based on TTL", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-02-03T00:00:00.000Z"));

      tracker.recordActual([createMessage(1, "old")], "claude-old", 1);

      vi.setSystemTime(new Date("2026-02-03T01:01:00.000Z"));

      tracker.recordActual([createMessage(1, "new")], "claude-new", 2);

      expect(tracker.getState("claude-old")).toBeUndefined();
      expect(tracker.getState("claude-new")).toBeDefined();

      vi.useRealTimers();
    });
  });

  describe("persistence", () => {
    it("persists state to memento", async () => {
      vi.useFakeTimers();
      const memento = createMockMemento();
      const trackerWithPersistence = new ConversationStateTracker(memento);

      const messages = [createMessage(1, "hello"), createMessage(2, "world")];
      trackerWithPersistence.recordActual(messages, "claude", 500);

      // Wait for debounced save
      await vi.advanceTimersByTimeAsync(1100);

      // Verify memento was updated
      expect(memento._store.has("conversationStateTracker.v1")).toBe(true);
      const stored = memento._store.get("conversationStateTracker.v1") as {
        version: number;
        entries: Array<{ key: string }>;
      };
      expect(stored.version).toBe(1);
      // Family-only keying: 1 entry per model family (RFC 00054)
      expect(stored.entries).toHaveLength(1);
      const keys = stored.entries.map((e) => e.key);
      expect(keys).toContain("claude");

      vi.useRealTimers();
    });

    it("loads state from memento on construction", async () => {
      vi.useFakeTimers();
      const memento = createMockMemento();
      const tracker1 = new ConversationStateTracker(memento);

      const messages = [createMessage(1, "hello"), createMessage(2, "world")];
      tracker1.recordActual(messages, "claude", 500);

      // Wait for debounced save
      await vi.advanceTimersByTimeAsync(1100);

      // Create new tracker with same memento - should load state
      const tracker2 = new ConversationStateTracker(memento);

      const result = tracker2.lookup(messages, "claude");
      expect(result.type).toBe("exact");
      expect(result.knownTokens).toBe(500);

      vi.useRealTimers();
    });

    it("survives extension restart round-trip", async () => {
      vi.useFakeTimers();
      const memento = createMockMemento();

      // First "session" - record data
      const tracker1 = new ConversationStateTracker(memento);
      const msg1 = [createMessage(1, "hello")];
      const msg2 = [createMessage(1, "hi there")];

      tracker1.recordActual(msg1, "claude", 100);
      tracker1.recordActual(msg2, "gpt-4", 200);

      await vi.advanceTimersByTimeAsync(1100);

      // Second "session" - load data (simulates restart)
      const tracker2 = new ConversationStateTracker(memento);

      // Family-only keying: 1 entry per model family (RFC 00054)
      expect(tracker2.size()).toBe(2);
      expect(tracker2.lookup(msg1, "claude").type).toBe("exact");
      expect(tracker2.lookup(msg2, "gpt-4").type).toBe("exact");
      expect(tracker2.lookup(msg1, "claude").knownTokens).toBe(100);
      expect(tracker2.lookup(msg2, "gpt-4").knownTokens).toBe(200);

      vi.useRealTimers();
    });

    it("filters stale entries on load", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-02-03T00:00:00.000Z"));

      const memento = createMockMemento();
      const tracker1 = new ConversationStateTracker(memento);

      tracker1.recordActual([createMessage(1, "old")], "claude", 100);
      await vi.advanceTimersByTimeAsync(1100);

      // Advance time past TTL (1 hour)
      vi.setSystemTime(new Date("2026-02-03T01:30:00.000Z"));

      // New tracker should not load stale entry
      const tracker2 = new ConversationStateTracker(memento);
      expect(tracker2.size()).toBe(0);

      vi.useRealTimers();
    });

    it("clear() removes persisted state", async () => {
      vi.useFakeTimers();
      const memento = createMockMemento();
      const tracker1 = new ConversationStateTracker(memento);

      tracker1.recordActual([createMessage(1, "hello")], "claude", 100);
      await vi.advanceTimersByTimeAsync(1100);

      expect(memento._store.has("conversationStateTracker.v1")).toBe(true);

      tracker1.clear();
      await vi.advanceTimersByTimeAsync(100);

      expect(memento._store.has("conversationStateTracker.v1")).toBe(false);

      vi.useRealTimers();
    });

    it("works without memento (in-memory only)", () => {
      const tracker1 = new ConversationStateTracker();
      const messages = [createMessage(1, "hello")];

      tracker1.recordActual(messages, "claude", 100);

      const result = tracker1.lookup(messages, "claude");
      expect(result.type).toBe("exact");
      expect(result.knownTokens).toBe(100);
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

describe("summarization guard (RFC 047 Phase 4b)", () => {
  let tracker: ConversationStateTracker;

  beforeEach(() => {
    tracker = new ConversationStateTracker();
  });

  it("clears lastSequenceEstimate from family key when summarization detected", () => {
    const messages = [createMessage(1, "hello")];

    // Record with sequence estimate — creates family-key with lastSequenceEstimate
    tracker.recordActual(messages, "claude", 100000, 50000);
    const stateBefore = tracker.getState("claude");
    expect(stateBefore?.lastSequenceEstimate).toBe(50000);

    // Record with summarization detected — should clear lastSequenceEstimate on family key
    const summaryMessages = [
      createMessage(
        1,
        "<conversation-summary>\\nSummary\\n</conversation-summary>",
      ),
    ];
    tracker.recordActual(summaryMessages, "claude", 30000, 25000, true);

    // Family key should NOT have lastSequenceEstimate
    const stateAfter = tracker.getState("claude");
    expect(stateAfter?.lastSequenceEstimate).toBeUndefined();
    expect(stateAfter?.actualTokens).toBe(30000);
  });

  it("preserves lastSequenceEstimate when no summarization detected", () => {
    const messages = [createMessage(1, "hello")];

    tracker.recordActual(messages, "claude", 100000, 50000);
    const state = tracker.getState("claude");
    expect(state?.lastSequenceEstimate).toBe(50000);
  });

  it("re-establishes adjustment after summarization on next non-summarized turn", () => {
    const messages = [createMessage(1, "hello")];

    // Turn 1: normal — establishes adjustment
    tracker.recordActual(messages, "claude", 100000, 50000);
    expect(tracker.getState("claude")?.lastSequenceEstimate).toBe(50000);

    // Turn 2: summarization detected — clears adjustment
    tracker.recordActual(messages, "claude", 30000, 25000, true);
    expect(tracker.getState("claude")?.lastSequenceEstimate).toBeUndefined();

    // Turn 3: normal again — re-establishes adjustment
    tracker.recordActual(messages, "claude", 35000, 30000, false);
    expect(tracker.getState("claude")?.lastSequenceEstimate).toBe(30000);
  });
});
