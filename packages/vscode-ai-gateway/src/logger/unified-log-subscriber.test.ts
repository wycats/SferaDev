import { describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Module-level mocks — satisfy imports that reach into vscode internals.
//
// These are NOT used in test assertions. They exist solely because the
// production module imports vscode (for createVscodeLogConfig) and the
// logger (which uses vscode.window). Our tests bypass both via interfaces.
//
// JIT note: when createVscodeLogConfig moves to its own file, the vscode
// mock here can be removed entirely.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
    workspaceFolders: [],
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
import {
  TestEventWriter,
  testLogConfig,
  testEvent,
} from "./unified-log-subscriber.test-helpers.js";

// ─────────────────────────────────────────────────────────────────────────────
// Tests — interface-driven, no fs or vscode mocks
// ─────────────────────────────────────────────────────────────────────────────

describe("createUnifiedLogSubscriber", () => {
  it("returns a subscriber when config is valid", () => {
    const writer = new TestEventWriter();
    const subscriber = createUnifiedLogSubscriber({
      writer,
      config: testLogConfig(),
    });

    expect(subscriber).not.toBeNull();
    expect(subscriber).toHaveProperty("onEvent");
  });

  it("creates the investigation directory on construction", () => {
    const writer = new TestEventWriter();
    createUnifiedLogSubscriber({
      writer,
      config: testLogConfig({ investigationName: "my-investigation" }),
    });

    expect(writer.dirs).toHaveLength(1);
    expect(writer.dirs[0]).toContain("my-investigation");
  });

  it("writes to events.jsonl inside the investigation directory", () => {
    const writer = new TestEventWriter();
    const subscriber = createUnifiedLogSubscriber({
      writer,
      config: testLogConfig({
        logDirectory: "/logs",
        investigationName: "inv1",
      }),
    });

    subscriber?.onEvent(testEvent());

    expect(writer.targetFile).toBe("/logs/inv1/events.jsonl");
  });

  it("appends JSONL on onEvent", () => {
    const writer = new TestEventWriter();
    const subscriber = createUnifiedLogSubscriber({
      writer,
      config: testLogConfig(),
    });
    expect(subscriber).not.toBeNull();

    subscriber!.onEvent(
      testEvent({ kind: "session.start", extensionVersion: "1.0.0" }),
    );

    expect(writer.events).toHaveLength(1);
    expect(writer.events[0]!.kind).toBe("session.start");
    // Raw line ends with newline
    expect(writer.written[0]!.line.endsWith("\n")).toBe(true);
  });

  it("appends multiple events in order", () => {
    const writer = new TestEventWriter();
    const subscriber = createUnifiedLogSubscriber({
      writer,
      config: testLogConfig(),
    })!;

    subscriber.onEvent(
      testEvent({ kind: "session.start", extensionVersion: "1.0.0" }),
    );
    subscriber.onEvent(testEvent({ kind: "session.end" }));

    expect(writer.events).toHaveLength(2);
    expect(writer.events[0]!.kind).toBe("session.start");
    expect(writer.events[1]!.kind).toBe("session.end");
  });

  it("silently handles write errors", () => {
    const writer = new TestEventWriter();
    writer.appendError = new Error("disk full");

    const subscriber = createUnifiedLogSubscriber({
      writer,
      config: testLogConfig(),
    });

    // Should not throw
    expect(() => subscriber?.onEvent(testEvent())).not.toThrow();
  });

  it("returns null when ensureDir fails", () => {
    const writer = new TestEventWriter();
    writer.ensureDirError = new Error("permission denied");

    const subscriber = createUnifiedLogSubscriber({
      writer,
      config: testLogConfig(),
    });

    expect(subscriber).toBeNull();
  });

  it("returns null when log directory is null", () => {
    const writer = new TestEventWriter();
    const subscriber = createUnifiedLogSubscriber({
      writer,
      config: testLogConfig({ logDirectory: null }),
    });

    expect(subscriber).toBeNull();
    expect(writer.dirs).toHaveLength(0);
  });

  it("returns null when log directory is empty string", () => {
    const writer = new TestEventWriter();
    const subscriber = createUnifiedLogSubscriber({
      writer,
      config: testLogConfig({ logDirectory: "" }),
    });

    expect(subscriber).toBeNull();
  });

  it("returns null when relative path and no workspace root", () => {
    const writer = new TestEventWriter();
    const subscriber = createUnifiedLogSubscriber({
      writer,
      config: testLogConfig({
        logDirectory: ".logs",
        workspaceRoot: null,
      }),
    });

    expect(subscriber).toBeNull();
  });

  it("resolves relative log directory against workspace root", () => {
    const writer = new TestEventWriter();
    createUnifiedLogSubscriber({
      writer,
      config: testLogConfig({
        logDirectory: ".logs",
        workspaceRoot: "/my/workspace",
        investigationName: "default",
      }),
    });

    expect(writer.dirs[0]).toBe("/my/workspace/.logs/default");
  });

  it("uses absolute log directory as-is", () => {
    const writer = new TestEventWriter();
    createUnifiedLogSubscriber({
      writer,
      config: testLogConfig({
        logDirectory: "/absolute/logs",
        workspaceRoot: "/ignored",
        investigationName: "inv",
      }),
    });

    expect(writer.dirs[0]).toBe("/absolute/logs/inv");
  });

  it("eventsOfKind filters correctly", () => {
    const writer = new TestEventWriter();
    const subscriber = createUnifiedLogSubscriber({
      writer,
      config: testLogConfig(),
    })!;

    subscriber.onEvent(
      testEvent({ kind: "session.start", extensionVersion: "1.0.0" }),
    );
    subscriber.onEvent(testEvent({ kind: "session.end" }));
    subscriber.onEvent(
      testEvent({ kind: "session.start", extensionVersion: "2.0.0" }),
    );

    const starts = writer.eventsOfKind("session.start");
    expect(starts).toHaveLength(2);
    expect(starts[0]!.extensionVersion).toBe("1.0.0");
    expect(starts[1]!.extensionVersion).toBe("2.0.0");
  });
});
