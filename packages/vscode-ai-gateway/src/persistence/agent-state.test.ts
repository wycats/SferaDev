/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "vscode";

const mockStatusBarItem = {
  text: "",
  tooltip: "",
  backgroundColor: undefined as unknown,
  command: undefined as string | undefined,
  name: undefined as string | undefined,
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
};

vi.mock("vscode", () => ({
  window: {
    createStatusBarItem: vi.fn(() => mockStatusBarItem),
  },
  env: {
    sessionId: "test-session-id",
  },
  StatusBarAlignment: {
    Left: 1,
    Right: 2,
  },
  ThemeColor: class ThemeColor {
    constructor(public id: string) {}
  },
  EventEmitter: class EventEmitter<T> {
    private listeners: ((e: T) => void)[] = [];
    event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: vi.fn() };
    };
    fire(data: T) {
      this.listeners.forEach((l) => { l(data); });
    }
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    dispose() {}
  },
}));

import { TokenStatusBar } from "../status-bar.js";
import { AGENT_STATE_STORE } from "./stores.js";
import { createMockMemento } from "./index.js";
import { PersistenceManagerImpl } from "./manager.js";

describe("Agent state persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatusBarItem.text = "";
    mockStatusBarItem.tooltip = "";
    mockStatusBarItem.backgroundColor = undefined;
  });

  it("defines the agent state store schema", () => {
    expect(AGENT_STATE_STORE.key).toBe("vercel.ai.agentState");
    expect(AGENT_STATE_STORE.version).toBe(1);
    expect(AGENT_STATE_STORE.scope).toBe("global");
    expect(AGENT_STATE_STORE.defaultValue).toEqual({ entries: {} });
    expect(AGENT_STATE_STORE.maxEntries).toBe(100);
    expect(AGENT_STATE_STORE.ttlMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("round-trips persisted agent state", async () => {
    const globalState = createMockMemento();
    const manager = new PersistenceManagerImpl(globalState, createMockMemento());
    const store = manager.getStore(AGENT_STATE_STORE);

    await store.update((current) => ({
      entries: {
        ...current.entries,
        "conv-1": {
          lastActualInputTokens: 1200,
          lastMessageCount: 4,
          turnCount: 2,
          modelId: "openai:gpt-4o",
          fetchedAt: 123456,
        },
      },
    }));

    const stored = store.get();
    expect(stored.entries["conv-1"]).toEqual({
      lastActualInputTokens: 1200,
      lastMessageCount: 4,
      turnCount: 2,
      modelId: "openai:gpt-4o",
      fetchedAt: 123456,
    });
  });

  it("falls back to persisted state when no in-memory agent exists", async () => {
    const globalState = createMockMemento();
    const workspaceState = createMockMemento();
    const statusBar = new TokenStatusBar();
    statusBar.initializePersistence({
      globalState,
      workspaceState,
    } as ExtensionContext);

    const manager = new PersistenceManagerImpl(globalState, workspaceState);
    const store = manager.getStore(AGENT_STATE_STORE);

    await store.set({
      entries: {
        "conv-1": {
          lastActualInputTokens: 900,
          lastMessageCount: 3,
          turnCount: 1,
          modelId: "anthropic:claude-sonnet-4",
          fetchedAt: Date.now(),
        },
      },
    });

    expect(statusBar.getAgentContext("conv-1")).toEqual({
      lastActualInputTokens: 900,
      lastMessageCount: 3,
    });
  });

  it("prefers in-memory agent state over persisted", async () => {
    const globalState = createMockMemento();
    const workspaceState = createMockMemento();
    const statusBar = new TokenStatusBar();
    statusBar.initializePersistence({
      globalState,
      workspaceState,
    } as ExtensionContext);

    statusBar.startAgent("agent-1", 1000, 8000, undefined, undefined, undefined, undefined, undefined, "conv-1");
    statusBar.completeAgent("agent-1", {
      inputTokens: 1500,
      outputTokens: 200,
      messageCount: 5,
    });

    const manager = new PersistenceManagerImpl(globalState, workspaceState);
    const store = manager.getStore(AGENT_STATE_STORE);
    await store.set({
      entries: {
        "conv-1": {
          lastActualInputTokens: 300,
          lastMessageCount: 1,
          turnCount: 1,
          modelId: "openai:gpt-4o",
          fetchedAt: Date.now(),
        },
      },
    });

    expect(statusBar.getAgentContext("conv-1")).toEqual({
      lastActualInputTokens: 1500,
      lastMessageCount: 5,
    });
  });

  it("ignores stale persisted entries", async () => {
    const globalState = createMockMemento();
    const workspaceState = createMockMemento();
    const statusBar = new TokenStatusBar();
    statusBar.initializePersistence({
      globalState,
      workspaceState,
    } as ExtensionContext);

    const manager = new PersistenceManagerImpl(globalState, workspaceState);
    const store = manager.getStore(AGENT_STATE_STORE);

    await store.set({
      entries: {
        "conv-1": {
          lastActualInputTokens: 0,
          lastMessageCount: 4,
          turnCount: 1,
          fetchedAt: Date.now(),
        },
        "conv-2": {
          lastActualInputTokens: 700,
          lastMessageCount: 0,
          turnCount: 1,
          fetchedAt: Date.now(),
        },
      },
    });

    expect(statusBar.getAgentContext("conv-1")).toBeUndefined();
    expect(statusBar.getAgentContext("conv-2")).toBeUndefined();
  });
});
