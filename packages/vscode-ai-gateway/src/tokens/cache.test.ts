import { describe, expect, it, vi } from "vitest";
import type { Memento } from "vscode";

const hoisted = vi.hoisted(() => {
  // Mock the role enum
  const LanguageModelChatMessageRole = {
    User: 1,
    Assistant: 2,
  };

  class LanguageModelTextPart {
    value: string;

    constructor(value: string) {
      this.value = value;
    }
  }

  class LanguageModelDataPart {
    data: Uint8Array;
    mimeType: string;

    constructor(data: Uint8Array, mimeType: string) {
      this.data = data;
      this.mimeType = mimeType;
    }
  }

  class LanguageModelToolCallPart {
    name: string;
    callId: string;
    input: unknown;

    constructor(name: string, callId: string, input: unknown) {
      this.name = name;
      this.callId = callId;
      this.input = input;
    }
  }

  class LanguageModelToolResultPart {
    callId: string;
    content: unknown[];

    constructor(callId: string, content: unknown[]) {
      this.callId = callId;
      this.content = content;
    }
  }

  return {
    LanguageModelChatMessageRole,
    LanguageModelTextPart,
    LanguageModelDataPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
  };
});

vi.mock("vscode", () => hoisted);

import * as vscode from "vscode";
import { TokenCache, type CachedTokenCount } from "./cache";
import { ConversationStateTracker } from "./conversation-state";
import { computeNormalizedDigest } from "../utils/digest";

describe("TokenCache", () => {
  const createMessage = (parts: unknown[]) =>
    ({
      role: vscode.LanguageModelChatMessageRole.User,
      name: "test",
      content: parts,
    }) as vscode.LanguageModelChatMessage;

  const createMockMemento = (
    initial: Record<string, unknown> = {},
  ): Memento & { _store: Map<string, unknown> } => {
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
  };

  const getCachedDigest = (cache: TokenCache): string | undefined => {
    const internal = cache as unknown as {
      cache: Map<string, CachedTokenCount>;
    };
    const entry = Array.from(internal.cache.values())[0];
    return entry?.digest;
  };

  it("treats identical content as the same cache entry", () => {
    const cache = new TokenCache();
    const messageA = createMessage([new vscode.LanguageModelTextPart("Hello")]);
    const messageB = createMessage([new vscode.LanguageModelTextPart("Hello")]);

    cache.cacheActual(messageA, "openai", 42);

    expect(cache.getCached(messageB, "openai")).toBe(42);
  });

  it("treats different content as different cache entries", () => {
    const cache = new TokenCache();
    const messageA = createMessage([new vscode.LanguageModelTextPart("Hello")]);
    const messageB = createMessage([
      new vscode.LanguageModelTextPart("Hello!"),
    ]);

    cache.cacheActual(messageA, "openai", 42);

    expect(cache.getCached(messageB, "openai")).toBeUndefined();
  });

  it("returns undefined for uncached messages", () => {
    const cache = new TokenCache();
    const message = createMessage([new vscode.LanguageModelTextPart("Hello")]);

    expect(cache.getCached(message, "openai")).toBeUndefined();
  });

  it("caches and retrieves actual tokens", () => {
    const cache = new TokenCache();
    const message = createMessage([new vscode.LanguageModelTextPart("Hello")]);

    cache.cacheActual(message, "openai", 42);

    expect(cache.getCached(message, "openai")).toBe(42);
  });

  it("isolates cache entries by model family", () => {
    const cache = new TokenCache();
    const message = createMessage([new vscode.LanguageModelTextPart("Hello")]);

    cache.cacheActual(message, "openai", 42);

    expect(cache.getCached(message, "anthropic")).toBeUndefined();
    expect(cache.getCached(message, "openai")).toBe(42);
  });

  it("includes tool result content in digest", () => {
    const cache = new TokenCache();
    const contentA = [new vscode.LanguageModelTextPart("Result")];
    const contentB = [new vscode.LanguageModelTextPart("Result changed")];
    const messageA = createMessage([
      new vscode.LanguageModelToolResultPart("call-1", contentA),
    ]);
    const messageB = createMessage([
      new vscode.LanguageModelToolResultPart("call-1", contentB),
    ]);

    cache.cacheActual(messageA, "openai", 42);
    expect(cache.getCached(messageB, "openai")).toBeUndefined();
  });

  it("includes plain object tool result content in digest", () => {
    const cache = new TokenCache();
    const contentA = [new vscode.LanguageModelTextPart("Result")];
    const contentB = [new vscode.LanguageModelTextPart("Result changed")];
    const messageA = createMessage([{ callId: "call-1", content: contentA }]);
    const messageB = createMessage([{ callId: "call-1", content: contentB }]);

    cache.cacheActual(messageA, "openai", 42);
    expect(cache.getCached(messageB, "openai")).toBeUndefined();
  });

  it("matches ConversationStateTracker digests for edge cases", () => {
    const tracker = new ConversationStateTracker();

    const messages = [
      createMessage([new vscode.LanguageModelTextPart("Hello")]),
      createMessage([
        new vscode.LanguageModelToolCallPart("tool-a", "call-1", { q: 1 }),
      ]),
      createMessage([
        new vscode.LanguageModelTextPart("Hello [Link](https://example.com)"),
      ]),
    ];

    messages[0]!.name = "named-message";
    messages[1]!.name = "named-tool-call";
    messages[2]!.name = "annotated";

    for (const message of messages) {
      const cache = new TokenCache();
      cache.cacheActual(message, "openai", 42);
      const cacheDigest = getCachedDigest(cache);

      tracker.recordActual([message], "openai", 42);
      const trackedDigest = tracker.getState("openai")?.messageHashes[0];

      const normalizedDigest = computeNormalizedDigest(message);

      expect(cacheDigest).toBe(normalizedDigest);
      expect(trackedDigest).toBe(normalizedDigest);
    }
  });

  it("persists state to memento after cacheActual (debounced)", async () => {
    vi.useFakeTimers();
    const memento = createMockMemento();
    const cache = new TokenCache(memento);
    const message = createMessage([new vscode.LanguageModelTextPart("Hello")]);

    cache.cacheActual(message, "openai", 42);

    await vi.advanceTimersByTimeAsync(1100);

    expect(memento._store.has("tokenCache.v1")).toBe(true);
    const stored = memento._store.get("tokenCache.v1") as {
      version: number;
      entries: Array<{ key: string; entry: CachedTokenCount }>;
    };
    expect(stored.version).toBe(1);
    expect(stored.entries).toHaveLength(1);
    const digest = computeNormalizedDigest(message);
    expect(stored.entries[0]?.key).toBe(`openai:${digest}`);
    expect(stored.entries[0]?.entry.actualTokens).toBe(42);

    vi.useRealTimers();
  });

  it("loads state from memento on construction", async () => {
    vi.useFakeTimers();
    const memento = createMockMemento();
    const cache1 = new TokenCache(memento);
    const message = createMessage([new vscode.LanguageModelTextPart("Hello")]);

    cache1.cacheActual(message, "openai", 42);
    await vi.advanceTimersByTimeAsync(1100);

    const cache2 = new TokenCache(memento);

    expect(cache2.getCached(message, "openai")).toBe(42);

    vi.useRealTimers();
  });

  it("filters stale entries on load (24h TTL)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-03T00:00:00.000Z"));

    const memento = createMockMemento();
    const cache1 = new TokenCache(memento);
    const message = createMessage([new vscode.LanguageModelTextPart("Hello")]);

    cache1.cacheActual(message, "openai", 42);
    await vi.advanceTimersByTimeAsync(1100);

    vi.setSystemTime(new Date("2026-02-04T00:00:00.001Z"));
    const cache2 = new TokenCache(memento);

    expect(cache2.getCached(message, "openai")).toBeUndefined();

    vi.useRealTimers();
  });

  it("evicts least recently used entries when exceeding max entries", () => {
    const cache = new TokenCache();
    const messages: vscode.LanguageModelChatMessage[] = [];

    for (let i = 0; i < 2000; i += 1) {
      const message = createMessage([
        new vscode.LanguageModelTextPart(`msg-${i.toString()}`),
      ]);
      messages.push(message);
      cache.cacheActual(message, "openai", i);
    }

    const overflowMessage = createMessage([
      new vscode.LanguageModelTextPart("msg-2000"),
    ]);
    cache.cacheActual(overflowMessage, "openai", 2000);

    expect(cache.getCached(messages[0]!, "openai")).toBeUndefined();
    expect(cache.getCached(messages[1]!, "openai")).toBe(1);
    expect(cache.getCached(overflowMessage, "openai")).toBe(2000);
  });

  it("works without memento (in-memory only)", () => {
    const cache = new TokenCache();
    const message = createMessage([new vscode.LanguageModelTextPart("Hello")]);

    cache.cacheActual(message, "openai", 42);

    expect(cache.getCached(message, "openai")).toBe(42);
  });
});
