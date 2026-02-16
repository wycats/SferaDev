import { beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Hoisted mocks
// ─────────────────────────────────────────────────────────────────────────────

const hoisted = vi.hoisted(() => {
  const mockMkdirSync = vi.fn();
  const mockAppendFileSync = vi.fn();
  const mockGetConfiguration = vi.fn();

  return { mockMkdirSync, mockAppendFileSync, mockGetConfiguration };
});

vi.mock("node:fs", () => ({
  mkdirSync: hoisted.mockMkdirSync,
  appendFileSync: hoisted.mockAppendFileSync,
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: hoisted.mockGetConfiguration,
    workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
  },
}));

vi.mock("../logger.js", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

import { createUnifiedLogSubscriber } from "./unified-log-subscriber.js";
import type { InvestigationEvent } from "./investigation-events.js";

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("createUnifiedLogSubscriber", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.mockGetConfiguration.mockReturnValue({
      get: (key: string) => {
        if (key === "logging.fileDirectory") return ".logs";
        if (key === "investigation.name") return "test-investigation";
        return undefined;
      },
    });
  });

  it("returns a subscriber when config is valid", () => {
    const subscriber = createUnifiedLogSubscriber();
    expect(subscriber).not.toBeNull();
    expect(subscriber).toHaveProperty("onEvent");
  });

  it("creates the investigation directory on construction", () => {
    createUnifiedLogSubscriber();
    expect(hoisted.mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("test-investigation"),
      { recursive: true },
    );
  });

  it("appends JSONL on onEvent", () => {
    const subscriber = createUnifiedLogSubscriber();
    expect(subscriber).not.toBeNull();

    const event: InvestigationEvent = {
      kind: "session.start",
      eventId: "01TEST",
      ts: "2026-01-01T00:00:00.000Z",
      sessionId: "s1",
      conversationId: "c1",
      chatId: "ch1",
      extensionVersion: "1.0.0",
    };

    subscriber?.onEvent(event);

    expect(hoisted.mockAppendFileSync).toHaveBeenCalledTimes(1);
    const [filePath, content, encoding] = hoisted.mockAppendFileSync.mock
      .calls[0] as [string, string, string];
    expect(filePath).toContain("events.jsonl");
    expect(encoding).toBe("utf8");
    expect(content).toContain('"kind":"session.start"');
    expect(content.endsWith("\n")).toBe(true);
  });

  it("silently handles write errors", () => {
    hoisted.mockAppendFileSync.mockImplementation(() => {
      throw new Error("disk full");
    });

    const subscriber = createUnifiedLogSubscriber();
    const event: InvestigationEvent = {
      kind: "session.end",
      eventId: "01TEST2",
      ts: "2026-01-01T00:00:01.000Z",
      sessionId: "s1",
      conversationId: "c1",
      chatId: "ch1",
    };

    // Should not throw
    expect(() => subscriber?.onEvent(event)).not.toThrow();
  });

  it("returns null when mkdirSync fails", () => {
    hoisted.mockMkdirSync.mockImplementation(() => {
      throw new Error("permission denied");
    });

    const subscriber = createUnifiedLogSubscriber();
    expect(subscriber).toBeNull();
  });

  it("returns null when log directory config is empty string", () => {
    hoisted.mockGetConfiguration.mockReturnValue({
      get: (key: string) => {
        if (key === "logging.fileDirectory") return "";
        if (key === "investigation.name") return "test";
        return undefined;
      },
    });

    const subscriber = createUnifiedLogSubscriber();
    expect(subscriber).toBeNull();
  });
});
