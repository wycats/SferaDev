import { describe, expect, it, vi } from "vitest";

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
});
