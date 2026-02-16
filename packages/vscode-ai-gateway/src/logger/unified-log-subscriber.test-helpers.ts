/**
 * Test helpers for unified-log-subscriber.
 *
 * Provides in-memory implementations of EventWriter and LogConfig
 * so tests can exercise createUnifiedLogSubscriber() without mocking
 * fs or vscode.
 */

import type { EventWriter, LogConfig } from "./unified-log-subscriber.js";
import type { InvestigationEvent } from "./investigation-events.js";

// ─────────────────────────────────────────────────────────────────────────────
// TestEventWriter — in-memory file system
// ─────────────────────────────────────────────────────────────────────────────

export interface WrittenLine {
  filePath: string;
  line: string;
}

/**
 * In-memory EventWriter that records all operations for assertion.
 *
 * Usage:
 *   const writer = new TestEventWriter();
 *   const sub = createUnifiedLogSubscriber({ writer, config });
 *   sub?.onEvent(someEvent);
 *   expect(writer.lines).toHaveLength(1);
 *   expect(writer.events[0].kind).toBe("session.start");
 */
export class TestEventWriter implements EventWriter {
  /** Directories created via ensureDir(). */
  readonly dirs: string[] = [];
  /** Raw lines appended via append(). */
  readonly written: WrittenLine[] = [];

  /** If set, ensureDir() will throw this error. */
  ensureDirError: Error | null = null;
  /** If set, append() will throw this error. */
  appendError: Error | null = null;

  ensureDir(dir: string): void {
    if (this.ensureDirError) throw this.ensureDirError;
    this.dirs.push(dir);
  }

  append(filePath: string, line: string): void {
    if (this.appendError) throw this.appendError;
    this.written.push({ filePath, line });
  }

  // ── Semantic assertions ──────────────────────────────────────────────

  /** All lines written, as raw strings (without trailing newline). */
  get lines(): string[] {
    return this.written.map((w) => w.line.replace(/\n$/, ""));
  }

  /** All lines parsed back into InvestigationEvent objects. */
  get events(): InvestigationEvent[] {
    return this.lines.map((l) => JSON.parse(l) as InvestigationEvent);
  }

  /** Events filtered by kind. */
  eventsOfKind<K extends InvestigationEvent["kind"]>(
    kind: K,
  ): Extract<InvestigationEvent, { kind: K }>[] {
    return this.events.filter(
      (e): e is Extract<InvestigationEvent, { kind: K }> => e.kind === kind,
    );
  }

  /** The single file path all events were written to (asserts uniformity). */
  get targetFile(): string {
    const paths = new Set(this.written.map((w) => w.filePath));
    if (paths.size !== 1) {
      throw new Error(
        `Expected exactly 1 target file, got ${paths.size.toString()}: ${[...paths].join(", ")}`,
      );
    }
    return [...paths][0]!;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TestLogConfig — configurable values
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a LogConfig with sensible test defaults.
 *
 * Override any field:
 *   testLogConfig({ logDirectory: null })  // simulate no config
 *   testLogConfig({ workspaceRoot: null }) // simulate no workspace
 */
export function testLogConfig(overrides?: Partial<LogConfig>): LogConfig {
  return {
    logDirectory: "/test-workspace/.logs",
    investigationName: "test-investigation",
    workspaceRoot: "/test-workspace",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Event factories
// ─────────────────────────────────────────────────────────────────────────────

let eventCounter = 0;

/**
 * Create a minimal InvestigationEvent for testing.
 *
 * Defaults to session.start with auto-incrementing eventId.
 */
export function testEvent(
  overrides?: Partial<InvestigationEvent>,
): InvestigationEvent {
  eventCounter++;
  return {
    kind: "session.start",
    eventId: `01TEST${eventCounter.toString().padStart(4, "0")}`,
    ts: new Date().toISOString(),
    sessionId: "test-session",
    conversationId: "test-conversation",
    chatId: "test-chat",
    extensionVersion: "0.0.0-test",
    ...overrides,
  } as InvestigationEvent;
}
