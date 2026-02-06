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

  describe("conversation isolation", () => {
    it("tracks different conversations separately for same model", () => {
      const messages1 = [createMessage(1, "hello")];
      const messages2 = [createMessage(1, "hi")];

      tracker.recordActual(messages1, "claude", 100, "conv-a");
      tracker.recordActual(messages2, "claude", 200, "conv-b");

      expect(tracker.getState("claude", "conv-a")?.actualTokens).toBe(100);
      expect(tracker.getState("claude", "conv-b")?.actualTokens).toBe(200);
    });

    it("subagent does not overwrite main agent state", () => {
      const mainMessages = [
        createMessage(1, "main"),
        createMessage(2, "response"),
      ];
      const subMessages = [
        createMessage(1, "subagent"),
        createMessage(2, "response"),
      ];

      tracker.recordActual(mainMessages, "claude", 300, "main");
      tracker.recordActual(subMessages, "claude", 150, "sub");

      const mainLookup = tracker.lookup(mainMessages, "claude", "main");
      const subLookup = tracker.lookup(subMessages, "claude", "sub");

      expect(mainLookup.type).toBe("exact");
      expect(subLookup.type).toBe("exact");
      expect(mainLookup.knownTokens).toBe(300);
      expect(subLookup.knownTokens).toBe(150);
    });

    it("falls back to model-only key when conversationId is undefined", () => {
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
      // Each recordActual with conversationId writes 2 entries:
      // per-conversation key + model-family-only key (RFC 047 Phase 4a).
      // The family key is always the same ("claude"), so after 100 iterations
      // we have 100 per-conversation entries + 1 family entry = 101 entries.
      // Use 99 iterations to stay under the 100 limit, then verify eviction.
      for (let i = 0; i < 99; i += 1) {
        tracker.recordActual(
          [createMessage(1, `msg-${i.toString()}`)],
          "claude",
          i,
          `conv-${i.toString()}`,
        );
      }

      // 99 per-conv + 1 family = 100 entries (at limit)
      expect(tracker.getState("claude", "conv-0")).toBeDefined();

      tracker.recordActual(
        [createMessage(1, "msg-99")],
        "claude",
        99,
        "conv-99",
      );

      // conv-0 should be evicted (oldest per-conversation entry)
      expect(tracker.getState("claude", "conv-0")).toBeUndefined();
      expect(tracker.getState("claude", "conv-99")).toBeDefined();
    });

    it("preserves recently used entries in LRU eviction", () => {
      for (let i = 0; i < 99; i += 1) {
        tracker.recordActual(
          [createMessage(1, `msg-${i.toString()}`)],
          "claude",
          i,
          `conv-${i.toString()}`,
        );
      }

      // Touch conv-0 to make it recently used
      const lookup = tracker.lookup(
        [createMessage(1, "msg-0")],
        "claude",
        "conv-0",
      );
      expect(lookup.type).toBe("exact");

      tracker.recordActual(
        [createMessage(1, "msg-99")],
        "claude",
        99,
        "conv-99",
      );

      // conv-0 was recently touched, so conv-1 should be evicted instead
      expect(tracker.getState("claude", "conv-0")).toBeDefined();
      expect(tracker.getState("claude", "conv-1")).toBeUndefined();
    });

    it("does not exceed maxEntries when new model family is introduced at capacity", () => {
      // Fill to capacity: 99 per-conv + 1 family = 100 entries
      for (let i = 0; i < 99; i += 1) {
        tracker.recordActual(
          [createMessage(1, `msg-${i.toString()}`)],
          "claude",
          i,
          `conv-${i.toString()}`,
        );
      }
      expect(tracker.size()).toBe(100);

      // Introduce a new model family — should evict to stay at 100
      tracker.recordActual(
        [createMessage(1, "gpt-msg")],
        "gpt-4",
        999,
        "conv-gpt",
      );

      // 2 new entries (per-conv + family for gpt-4), so 2 old entries evicted
      expect(tracker.size()).toBeLessThanOrEqual(100);
      expect(tracker.getState("gpt-4", "conv-gpt")).toBeDefined();
      // Family-only key for gpt-4 should also exist
      expect(tracker.getState("gpt-4", undefined)).toBeDefined();
    });

    it("cleans up stale entries based on TTL", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-02-03T00:00:00.000Z"));

      tracker.recordActual([createMessage(1, "old")], "claude", 1, "conv-old");

      vi.setSystemTime(new Date("2026-02-03T01:01:00.000Z"));

      tracker.recordActual([createMessage(1, "new")], "claude", 2, "conv-new");

      expect(tracker.getState("claude", "conv-old")).toBeUndefined();
      expect(tracker.getState("claude", "conv-new")).toBeDefined();

      vi.useRealTimers();
    });
  });

  describe("persistence", () => {
    it("persists state to memento", async () => {
      vi.useFakeTimers();
      const memento = createMockMemento();
      const trackerWithPersistence = new ConversationStateTracker(memento);

      const messages = [createMessage(1, "hello"), createMessage(2, "world")];
      trackerWithPersistence.recordActual(messages, "claude", 500, "conv-1");

      // Wait for debounced save
      await vi.advanceTimersByTimeAsync(1100);

      // Verify memento was updated
      expect(memento._store.has("conversationStateTracker.v1")).toBe(true);
      const stored = memento._store.get("conversationStateTracker.v1") as {
        version: number;
        entries: Array<{ key: string }>;
      };
      expect(stored.version).toBe(1);
      // 2 entries: per-conversation key + model-family-only key (RFC 047 dual-write)
      expect(stored.entries).toHaveLength(2);
      const keys = stored.entries.map((e) => e.key);
      expect(keys).toContain("claude:conv-1");
      expect(keys).toContain("claude");

      vi.useRealTimers();
    });

    it("loads state from memento on construction", async () => {
      vi.useFakeTimers();
      const memento = createMockMemento();
      const tracker1 = new ConversationStateTracker(memento);

      const messages = [createMessage(1, "hello"), createMessage(2, "world")];
      tracker1.recordActual(messages, "claude", 500, "conv-1");

      // Wait for debounced save
      await vi.advanceTimersByTimeAsync(1100);

      // Create new tracker with same memento - should load state
      const tracker2 = new ConversationStateTracker(memento);

      const result = tracker2.lookup(messages, "claude", "conv-1");
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

      tracker1.recordActual(msg1, "claude", 100, "conv-a");
      tracker1.recordActual(msg2, "gpt-4", 200, "conv-b");

      await vi.advanceTimersByTimeAsync(1100);

      // Second "session" - load data (simulates restart)
      const tracker2 = new ConversationStateTracker(memento);

      // 4 entries: 2 per-conversation + 2 model-family-only (RFC 047 dual-write)
      expect(tracker2.size()).toBe(4);
      expect(tracker2.lookup(msg1, "claude", "conv-a").type).toBe("exact");
      expect(tracker2.lookup(msg2, "gpt-4", "conv-b").type).toBe("exact");
      expect(tracker2.lookup(msg1, "claude", "conv-a").knownTokens).toBe(100);
      expect(tracker2.lookup(msg2, "gpt-4", "conv-b").knownTokens).toBe(200);

      vi.useRealTimers();
    });

    it("filters stale entries on load", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-02-03T00:00:00.000Z"));

      const memento = createMockMemento();
      const tracker1 = new ConversationStateTracker(memento);

      tracker1.recordActual([createMessage(1, "old")], "claude", 100, "old");
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
    tracker.recordActual(messages, "claude", 100000, "conv-1", 50000);
    const stateBefore = tracker.getState("claude", undefined);
    expect(stateBefore?.lastSequenceEstimate).toBe(50000);

    // Record with summarization detected — should clear lastSequenceEstimate on family key
    const summaryMessages = [
      createMessage(
        1,
        "<conversation-summary>\nSummary\n</conversation-summary>",
      ),
    ];
    tracker.recordActual(
      summaryMessages,
      "claude",
      30000,
      "conv-1",
      25000,
      true,
    );

    // Family key should NOT have lastSequenceEstimate
    const stateAfter = tracker.getState("claude", undefined);
    expect(stateAfter?.lastSequenceEstimate).toBeUndefined();
    expect(stateAfter?.actualTokens).toBe(30000);

    // Per-conversation key should still have it (not affected by guard)
    const convState = tracker.getState("claude", "conv-1");
    expect(convState?.lastSequenceEstimate).toBe(25000);
  });

  it("preserves lastSequenceEstimate when no summarization detected", () => {
    const messages = [createMessage(1, "hello")];

    tracker.recordActual(messages, "claude", 100000, "conv-1", 50000);
    const state = tracker.getState("claude", undefined);
    expect(state?.lastSequenceEstimate).toBe(50000);
  });

  it("re-establishes adjustment after summarization on next non-summarized turn", () => {
    const messages = [createMessage(1, "hello")];

    // Turn 1: normal — establishes adjustment
    tracker.recordActual(messages, "claude", 100000, "conv-1", 50000);
    expect(tracker.getState("claude", undefined)?.lastSequenceEstimate).toBe(
      50000,
    );

    // Turn 2: summarization detected — clears adjustment
    tracker.recordActual(messages, "claude", 30000, "conv-1", 25000, true);
    expect(
      tracker.getState("claude", undefined)?.lastSequenceEstimate,
    ).toBeUndefined();

    // Turn 3: normal again — re-establishes adjustment
    tracker.recordActual(messages, "claude", 35000, "conv-1", 30000, false);
    expect(tracker.getState("claude", undefined)?.lastSequenceEstimate).toBe(
      30000,
    );
  });
});
