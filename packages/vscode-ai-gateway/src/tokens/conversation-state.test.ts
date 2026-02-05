import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModelChatMessage, Memento } from "vscode";
import { ConversationStateTracker } from "./conversation-state";

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
      for (let i = 0; i < 100; i += 1) {
        tracker.recordActual(
          [createMessage(1, `msg-${i.toString()}`)],
          "claude",
          i,
          `conv-${i.toString()}`,
        );
      }

      expect(tracker.getState("claude", "conv-0")).toBeDefined();

      tracker.recordActual(
        [createMessage(1, "msg-100")],
        "claude",
        100,
        "conv-100",
      );

      expect(tracker.getState("claude", "conv-0")).toBeUndefined();
      expect(tracker.getState("claude", "conv-100")).toBeDefined();
    });

    it("preserves recently used entries in LRU eviction", () => {
      for (let i = 0; i < 100; i += 1) {
        tracker.recordActual(
          [createMessage(1, `msg-${i.toString()}`)],
          "claude",
          i,
          `conv-${i.toString()}`,
        );
      }

      const lookup = tracker.lookup(
        [createMessage(1, "msg-0")],
        "claude",
        "conv-0",
      );
      expect(lookup.type).toBe("exact");

      tracker.recordActual(
        [createMessage(1, "msg-100")],
        "claude",
        100,
        "conv-100",
      );

      expect(tracker.getState("claude", "conv-0")).toBeDefined();
      expect(tracker.getState("claude", "conv-1")).toBeUndefined();
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
      expect(stored.entries).toHaveLength(1);
      expect(stored.entries[0]?.key).toBe("claude:conv-1");

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

      expect(tracker2.size()).toBe(2);
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
