import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock logger (imports vscode)
vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

// Mock investigation.js (imports vscode) — only sanitizePathSegment is used
vi.mock("./investigation.js", () => ({
  sanitizePathSegment: (segment: string) => segment,
}));

import type { ErrorIndexEntry } from "./error-capture.js";
import { pruneErrorLogs } from "./error-capture-prune.js";

const MS_PER_DAY = 86_400_000;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "error-prune-"));
}

function makeEntry(daysAgo: number, overrides: Partial<ErrorIndexEntry> = {}): ErrorIndexEntry {
  const ts = new Date(Date.now() - daysAgo * MS_PER_DAY).toISOString();
  return {
    ts,
    durationMs: 1000,
    chatId: overrides.chatId ?? `chat-${Math.random().toString(36).slice(2, 10)}`,
    conversationId: overrides.conversationId ?? "conv-1",
    model: "test/model",
    errorType: "timeout",
    errorMessage: "boom",
    eventCount: 1,
    textPartCount: 1,
    toolCallCount: 0,
    isSummarization: false,
    ...overrides,
  };
}

function writeIndex(errorsDir: string, entries: ErrorIndexEntry[]): void {
  fs.mkdirSync(errorsDir, { recursive: true });
  const content = entries.length === 0
    ? ""
    : `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  fs.writeFileSync(path.join(errorsDir, "index.jsonl"), content, "utf8");
}

function writeEntryFiles(
  errorsDir: string,
  entry: ErrorIndexEntry,
  sizes: { jsonSize?: number; sseSize?: number } = {},
): { jsonPath: string; ssePath: string } {
  const dateDir = entry.ts.slice(0, 10);
  const dayDir = path.join(errorsDir, dateDir);
  fs.mkdirSync(dayDir, { recursive: true });

  const jsonPath = path.join(dayDir, `${entry.chatId}.json`);
  const ssePath = path.join(dayDir, `${entry.chatId}.sse.jsonl`);

  const jsonSize = sizes.jsonSize ?? 128;
  const sseSize = sizes.sseSize ?? 64;

  fs.writeFileSync(jsonPath, "x".repeat(jsonSize), "utf8");
  fs.writeFileSync(ssePath, "y".repeat(sseSize), "utf8");

  return { jsonPath, ssePath };
}

function readIndex(errorsDir: string): ErrorIndexEntry[] {
  const indexPath = path.join(errorsDir, "index.jsonl");
  if (!fs.existsSync(indexPath)) {
    return [];
  }

  const content = fs.readFileSync(indexPath, "utf8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ErrorIndexEntry);
}

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe("pruneErrorLogs", () => {
  it("returns zeros when errors directory does not exist", async () => {
    tmpDir = createTempDir();
    const errorsDir = path.join(tmpDir, "missing-errors");

    const result = await pruneErrorLogs(errorsDir);

    expect(result).toEqual({ entriesRemoved: 0, filesDeleted: 0, bytesFreed: 0 });
  });

  it("returns zeros when index.jsonl is empty", async () => {
    tmpDir = createTempDir();
    const errorsDir = path.join(tmpDir, "errors");

    writeIndex(errorsDir, []);

    const result = await pruneErrorLogs(errorsDir);

    expect(result).toEqual({ entriesRemoved: 0, filesDeleted: 0, bytesFreed: 0 });
  });

  it("prunes entries older than maxAgeDays", async () => {
    tmpDir = createTempDir();
    const errorsDir = path.join(tmpDir, "errors");

    const oldEntry = makeEntry(100, { chatId: "chat-old" });
    const midEntry = makeEntry(50, { chatId: "chat-mid" });
    const newEntry = makeEntry(10, { chatId: "chat-new" });

    writeIndex(errorsDir, [oldEntry, midEntry, newEntry]);
    const oldPaths = writeEntryFiles(errorsDir, oldEntry);
    writeEntryFiles(errorsDir, midEntry);
    writeEntryFiles(errorsDir, newEntry);

    const result = await pruneErrorLogs(errorsDir, { maxAgeDays: 90 });

    expect(result.entriesRemoved).toBe(1);
    expect(fs.existsSync(oldPaths.jsonPath)).toBe(false);
    expect(fs.existsSync(oldPaths.ssePath)).toBe(false);

    const remaining = readIndex(errorsDir).map((entry) => entry.chatId);
    expect(remaining).toEqual(["chat-mid", "chat-new"]);
  });

  it("prunes oldest entries when over size cap", async () => {
    tmpDir = createTempDir();
    const errorsDir = path.join(tmpDir, "errors");

    const entry1 = makeEntry(5, { chatId: "chat-1" });
    const entry2 = makeEntry(4, { chatId: "chat-2" });
    const entry3 = makeEntry(3, { chatId: "chat-3" });

    writeIndex(errorsDir, [entry1, entry2, entry3]);
    writeEntryFiles(errorsDir, entry1, { jsonSize: 1500, sseSize: 1500 });
    writeEntryFiles(errorsDir, entry2, { jsonSize: 1500, sseSize: 1500 });
    writeEntryFiles(errorsDir, entry3, { jsonSize: 1500, sseSize: 1500 });

    // Cap at 4000 bytes — each entry is ~3000 bytes of data files, so only
    // the newest entry (chat-3) should survive after oldest-first eviction.
    // The index.jsonl overhead (~200 bytes) keeps the total under 4000.
    const result = await pruneErrorLogs(errorsDir, { maxSizeBytes: 4000 });

    expect(result.entriesRemoved).toBeGreaterThanOrEqual(1);
    const remaining = readIndex(errorsDir).map((entry) => entry.chatId);
    expect(remaining).toEqual(["chat-3"]);
  });

  it("removes empty date directories after pruning", async () => {
    tmpDir = createTempDir();
    const errorsDir = path.join(tmpDir, "errors");

    const oldEntry = makeEntry(100, { chatId: "chat-old" });
    const newEntry = makeEntry(5, { chatId: "chat-new" });

    writeIndex(errorsDir, [oldEntry, newEntry]);
    writeEntryFiles(errorsDir, oldEntry);
    writeEntryFiles(errorsDir, newEntry);

    const oldDateDir = path.join(errorsDir, oldEntry.ts.slice(0, 10));

    await pruneErrorLogs(errorsDir, { maxAgeDays: 90 });

    expect(fs.existsSync(oldDateDir)).toBe(false);
  });

  it("handles both age and size pruning in one call", async () => {
    tmpDir = createTempDir();
    const errorsDir = path.join(tmpDir, "errors");

    const oldEntry = makeEntry(120, { chatId: "chat-old" });
    const entry1 = makeEntry(5, { chatId: "chat-1" });
    const entry2 = makeEntry(4, { chatId: "chat-2" });
    const entry3 = makeEntry(3, { chatId: "chat-3" });

    writeIndex(errorsDir, [oldEntry, entry1, entry2, entry3]);
    writeEntryFiles(errorsDir, oldEntry, { jsonSize: 500, sseSize: 500 });
    writeEntryFiles(errorsDir, entry1, { jsonSize: 1500, sseSize: 1500 });
    writeEntryFiles(errorsDir, entry2, { jsonSize: 1500, sseSize: 1500 });
    writeEntryFiles(errorsDir, entry3, { jsonSize: 1500, sseSize: 1500 });

    // Age prune removes chat-old (120 days). Size cap at 4000 bytes removes
    // chat-1 and chat-2 (oldest first), leaving only chat-3.
    const result = await pruneErrorLogs(errorsDir, {
      maxAgeDays: 90,
      maxSizeBytes: 4000,
    });

    expect(result.entriesRemoved).toBeGreaterThanOrEqual(2);
    const remaining = readIndex(errorsDir).map((entry) => entry.chatId);
    expect(remaining).toEqual(["chat-3"]);
  });
});
