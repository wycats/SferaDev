import assert from "node:assert";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const mockReaddir = vi.fn();
  const mockReadFile = vi.fn();
  const mockWriteFile = vi.fn();
  const mockUnlink = vi.fn();
  const mockRm = vi.fn();
  const mockRmdir = vi.fn();

  return {
    mockReaddir,
    mockReadFile,
    mockWriteFile,
    mockUnlink,
    mockRm,
    mockRmdir,
  };
});

vi.mock("node:fs", () => ({
  promises: {
    readdir: hoisted.mockReaddir,
    readFile: hoisted.mockReadFile,
    writeFile: hoisted.mockWriteFile,
    unlink: hoisted.mockUnlink,
    rm: hoisted.mockRm,
    rmdir: hoisted.mockRmdir,
  },
}));

import {
  deleteInvestigation,
  listInvestigations,
  parseIndexEntries,
  pruneInvestigation,
} from "./investigation-prune.js";
import type { IndexEntry } from "./investigation.js";

const fileState = new Map<string, string>();
const dirState = new Map<string, Set<string>>();

function resetFs() {
  fileState.clear();
  dirState.clear();
}

function ensureDir(dirPath: string) {
  if (!dirState.has(dirPath)) {
    dirState.set(dirPath, new Set());
  }
}

function addEntry(dirPath: string, name: string) {
  ensureDir(dirPath);
  dirState.get(dirPath)!.add(name);
}

function addDir(dirPath: string) {
  ensureDir(dirPath);
  const parent = path.dirname(dirPath);
  if (parent !== dirPath) {
    addEntry(parent, path.basename(dirPath));
  }
}

function addFile(filePath: string, content: string) {
  fileState.set(filePath, content);
  addEntry(path.dirname(filePath), path.basename(filePath));
}

function removeEntry(dirPath: string, name: string) {
  dirState.get(dirPath)?.delete(name);
}

function makeDirent(dirPath: string, name: string) {
  return {
    name,
    isDirectory: () => dirState.has(path.join(dirPath, name)),
  };
}

function jsonl(entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

function makeIndexEntry(overrides: Partial<IndexEntry> = {}): IndexEntry {
  return {
    ts: "2026-02-10T00:00:00.000Z",
    durationMs: 1000,
    ttftMs: 200,
    conversationId: "conv-1",
    chatId: "chat-1",
    responseId: null,
    model: "test/model",
    messageCount: 1,
    toolCount: 0,
    estimatedInputTokens: 100,
    status: "success",
    finishReason: null,
    actualInputTokens: 100,
    actualOutputTokens: 10,
    cachedTokens: null,
    reasoningTokens: null,
    tokenDelta: null,
    tokenDeltaPct: null,
    isSummarization: false,
    ...overrides,
  };
}

beforeEach(() => {
  resetFs();
  vi.clearAllMocks();

  hoisted.mockReadFile.mockImplementation(async (filePath: string) => {
    if (fileState.has(filePath)) {
      return fileState.get(filePath)!;
    }
    const err = new Error("ENOENT");
    (err as { code?: string }).code = "ENOENT";
    throw err;
  });

  hoisted.mockWriteFile.mockImplementation(
    async (filePath: string, content) => {
      fileState.set(filePath, String(content));
      addEntry(path.dirname(filePath), path.basename(filePath));
    },
  );

  hoisted.mockUnlink.mockImplementation(async (filePath: string) => {
    if (fileState.has(filePath)) {
      fileState.delete(filePath);
      removeEntry(path.dirname(filePath), path.basename(filePath));
      return;
    }
    const err = new Error("ENOENT");
    (err as { code?: string }).code = "ENOENT";
    throw err;
  });

  hoisted.mockRmdir.mockImplementation(async (dirPath: string) => {
    dirState.delete(dirPath);
    removeEntry(path.dirname(dirPath), path.basename(dirPath));
  });

  hoisted.mockReaddir.mockImplementation(async (dirPath: string, options) => {
    const entries = Array.from(dirState.get(dirPath) ?? []);
    if (options && typeof options === "object" && options.withFileTypes) {
      return entries.map((name) => makeDirent(dirPath, name));
    }
    return entries;
  });
});

describe("parseIndexEntries", () => {
  it("parses valid JSONL with multiple entries", () => {
    const content = jsonl([
      makeIndexEntry({ chatId: "chat-1" }),
      makeIndexEntry({ chatId: "chat-2" }),
    ]);
    const entries = parseIndexEntries(content);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.chatId).toBe("chat-1");
    expect(entries[1]!.chatId).toBe("chat-2");
  });

  it("skips empty lines", () => {
    const content = `${JSON.stringify(makeIndexEntry())}\n\n${JSON.stringify(
      makeIndexEntry({ chatId: "chat-2" }),
    )}\n`;
    const entries = parseIndexEntries(content);
    expect(entries).toHaveLength(2);
  });

  it("skips malformed JSON lines", () => {
    const content = `${JSON.stringify(makeIndexEntry())}\n{bad json}\n`;
    const entries = parseIndexEntries(content);
    expect(entries).toHaveLength(1);
  });

  it("returns empty array for empty input", () => {
    expect(parseIndexEntries("")).toEqual([]);
  });
});

describe("listInvestigations", () => {
  it("lists investigations with correct stats", async () => {
    const logDir = "/logs";
    addDir(logDir);
    addDir("/logs/inv-a");
    addDir("/logs/inv-b");
    addFile(
      "/logs/inv-a/index.jsonl",
      jsonl([
        makeIndexEntry({
          ts: "2026-02-01T00:00:00.000Z",
          conversationId: "conv-1",
        }),
        makeIndexEntry({
          ts: "2026-02-02T00:00:00.000Z",
          conversationId: "conv-2",
        }),
      ]),
    );
    addFile(
      "/logs/inv-b/index.jsonl",
      jsonl([
        makeIndexEntry({
          ts: "2026-02-03T00:00:00.000Z",
          conversationId: "conv-3",
        }),
      ]),
    );

    const investigations = await listInvestigations(logDir);
    expect(investigations).toHaveLength(2);

    const invA = investigations.find((inv) => inv.name === "inv-a");
    expect(invA?.entryCount).toBe(2);
    expect(invA?.conversationCount).toBe(2);
    expect(invA?.oldestEntry?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(invA?.newestEntry?.toISOString()).toBe("2026-02-02T00:00:00.000Z");
  });

  it("handles empty log directory", async () => {
    const logDir = "/logs";
    addDir(logDir);

    const investigations = await listInvestigations(logDir);
    expect(investigations).toEqual([]);
  });

  it("skips directories without index.jsonl", async () => {
    const logDir = "/logs";
    addDir(logDir);
    addDir("/logs/inv-a");
    addDir("/logs/inv-b");
    addFile("/logs/inv-a/index.jsonl", jsonl([makeIndexEntry()]));

    const investigations = await listInvestigations(logDir);
    expect(investigations).toHaveLength(1);
    expect(investigations[0]!.name).toBe("inv-a");
  });

  it("handles corrupt index.jsonl gracefully", async () => {
    const logDir = "/logs";
    addDir(logDir);
    addDir("/logs/bad");
    addFile("/logs/bad/index.jsonl", "not json\n");

    const investigations = await listInvestigations(logDir);
    expect(investigations).toEqual([]);
  });
});

describe("pruneInvestigation", () => {
  it("removes matching entries and their files", async () => {
    const investigationDir = "/logs/inv-1";
    addDir("/logs");
    addDir(investigationDir);
    addDir("/logs/inv-1/conv-1");
    addDir("/logs/inv-1/conv-1/messages");
    addDir("/logs/inv-1/conv-2");
    addDir("/logs/inv-1/conv-2/messages");

    addFile(
      "/logs/inv-1/index.jsonl",
      jsonl([
        makeIndexEntry({ conversationId: "conv-1", chatId: "chat-1" }),
        makeIndexEntry({ conversationId: "conv-1", chatId: "chat-2" }),
        makeIndexEntry({ conversationId: "conv-2", chatId: "chat-3" }),
      ]),
    );
    addFile(
      "/logs/inv-1/conv-1/messages.jsonl",
      jsonl([
        { chatId: "chat-1", note: "remove" },
        { chatId: "chat-2", note: "keep" },
      ]),
    );
    addFile(
      "/logs/inv-1/conv-2/messages.jsonl",
      jsonl([{ chatId: "chat-3", note: "remove" }]),
    );
    addFile("/logs/inv-1/conv-1/messages/chat-1.json", "{}");
    addFile("/logs/inv-1/conv-1/messages/chat-1.sse.jsonl", "{}");
    addFile("/logs/inv-1/conv-1/messages/chat-2.json", "{}");
    addFile("/logs/inv-1/conv-1/messages/chat-2.sse.jsonl", "{}");
    addFile("/logs/inv-1/conv-2/messages/chat-3.json", "{}");
    addFile("/logs/inv-1/conv-2/messages/chat-3.sse.jsonl", "{}");

    const result = await pruneInvestigation(
      investigationDir,
      (entry) => entry.chatId === "chat-1" || entry.chatId === "chat-3",
    );

    expect(result.entriesRemoved).toBe(2);
    expect(result.filesDeleted).toBe(5);
    expect(result.conversationsAffected).toBe(2);

    expect(hoisted.mockUnlink).toHaveBeenCalledWith(
      "/logs/inv-1/conv-1/messages/chat-1.json",
    );
    expect(hoisted.mockUnlink).toHaveBeenCalledWith(
      "/logs/inv-1/conv-1/messages/chat-1.sse.jsonl",
    );
    expect(hoisted.mockUnlink).toHaveBeenCalledWith(
      "/logs/inv-1/conv-2/messages/chat-3.json",
    );
    expect(hoisted.mockUnlink).toHaveBeenCalledWith(
      "/logs/inv-1/conv-2/messages/chat-3.sse.jsonl",
    );

    const indexWrite = hoisted.mockWriteFile.mock.calls.find(
      ([filePath]) => filePath === "/logs/inv-1/index.jsonl",
    );
    expect(indexWrite).toBeDefined();

    const messagesWrite = hoisted.mockWriteFile.mock.calls.find(
      ([filePath]) => filePath === "/logs/inv-1/conv-1/messages.jsonl",
    );
    expect(messagesWrite).toBeDefined();

    expect(hoisted.mockRmdir).toHaveBeenCalledWith(
      "/logs/inv-1/conv-2/messages",
    );
    expect(hoisted.mockRmdir).toHaveBeenCalledWith("/logs/inv-1/conv-2");
  });

  it("removes empty investigation directory", async () => {
    const investigationDir = "/logs/inv-2";
    addDir("/logs");
    addDir(investigationDir);
    addDir("/logs/inv-2/conv-1");
    addDir("/logs/inv-2/conv-1/messages");

    addFile(
      "/logs/inv-2/index.jsonl",
      jsonl([makeIndexEntry({ conversationId: "conv-1", chatId: "chat-1" })]),
    );
    addFile("/logs/inv-2/conv-1/messages.jsonl", jsonl([{ chatId: "chat-1" }]));
    addFile("/logs/inv-2/conv-1/messages/chat-1.json", "{}");
    addFile("/logs/inv-2/conv-1/messages/chat-1.sse.jsonl", "{}");

    const result = await pruneInvestigation(
      investigationDir,
      (entry) => entry.chatId === "chat-1",
    );

    expect(result.entriesRemoved).toBe(1);
    expect(result.filesDeleted).toBe(4);
    expect(result.conversationsAffected).toBe(1);
    expect(hoisted.mockRmdir).toHaveBeenCalledWith(investigationDir);
  });

  it("handles missing per-chat files gracefully", async () => {
    const investigationDir = "/logs/inv-3";
    addDir("/logs");
    addDir(investigationDir);
    addDir("/logs/inv-3/conv-1");
    addDir("/logs/inv-3/conv-1/messages");

    addFile(
      "/logs/inv-3/index.jsonl",
      jsonl([makeIndexEntry({ conversationId: "conv-1", chatId: "chat-1" })]),
    );
    addFile("/logs/inv-3/conv-1/messages.jsonl", jsonl([{ chatId: "chat-1" }]));

    const result = await pruneInvestigation(
      investigationDir,
      (entry) => entry.chatId === "chat-1",
    );

    expect(result.entriesRemoved).toBe(1);
    expect(result.filesDeleted).toBe(2);
  });

  it("keeps entries that do not match the predicate", async () => {
    const investigationDir = "/logs/inv-4";
    addDir("/logs");
    addDir(investigationDir);
    addDir("/logs/inv-4/conv-1");
    addDir("/logs/inv-4/conv-1/messages");

    addFile(
      "/logs/inv-4/index.jsonl",
      jsonl([
        makeIndexEntry({ conversationId: "conv-1", chatId: "chat-1" }),
        makeIndexEntry({ conversationId: "conv-1", chatId: "chat-2" }),
      ]),
    );
    addFile(
      "/logs/inv-4/conv-1/messages.jsonl",
      jsonl([{ chatId: "chat-1" }, { chatId: "chat-2" }]),
    );
    addFile("/logs/inv-4/conv-1/messages/chat-1.json", "{}");
    addFile("/logs/inv-4/conv-1/messages/chat-1.sse.jsonl", "{}");

    const result = await pruneInvestigation(
      investigationDir,
      (entry) => entry.chatId === "chat-1",
    );

    expect(result.entriesRemoved).toBe(1);
    const indexWrite = hoisted.mockWriteFile.mock.calls.find(
      ([filePath]) => filePath === "/logs/inv-4/index.jsonl",
    );
    expect(indexWrite).toBeDefined();

    const [_, content] = indexWrite as [string, string];
    const keptLines = content.trim().split("\n");
    expect(keptLines).toHaveLength(1);
    const firstLine = keptLines[0];
    assert(firstLine);
    expect((JSON.parse(firstLine) as { chatId: string }).chatId).toBe("chat-2");
  });

  it("handles investigation with no matching entries (no-op)", async () => {
    const investigationDir = "/logs/inv-5";
    addDir("/logs");
    addDir(investigationDir);
    addFile(
      "/logs/inv-5/index.jsonl",
      jsonl([makeIndexEntry({ chatId: "chat-1" })]),
    );

    const result = await pruneInvestigation(
      investigationDir,
      (entry) => entry.chatId === "chat-2",
    );

    expect(result).toEqual({
      entriesRemoved: 0,
      filesDeleted: 0,
      conversationsAffected: 0,
    });
    expect(hoisted.mockWriteFile).not.toHaveBeenCalled();
    expect(hoisted.mockUnlink).not.toHaveBeenCalled();
  });

  it("follows RFC spider deletion order: files → messages.jsonl → index.jsonl → empty dirs", async () => {
    const investigationDir = "/logs/inv-order";
    addDir("/logs");
    addDir(investigationDir);
    addDir("/logs/inv-order/conv-1");
    addDir("/logs/inv-order/conv-1/messages");

    addFile(
      "/logs/inv-order/index.jsonl",
      jsonl([makeIndexEntry({ conversationId: "conv-1", chatId: "chat-1" })]),
    );
    addFile(
      "/logs/inv-order/conv-1/messages.jsonl",
      jsonl([{ chatId: "chat-1" }]),
    );
    addFile("/logs/inv-order/conv-1/messages/chat-1.json", "{}");

    // Track call order across all mock fns
    const callOrder: string[] = [];
    const origUnlink = hoisted.mockUnlink.getMockImplementation()!;
    const origWriteFile = hoisted.mockWriteFile.getMockImplementation()!;
    const origRmdir = hoisted.mockRmdir.getMockImplementation()!;
    hoisted.mockUnlink.mockImplementation(async (p: string) => {
      callOrder.push(`unlink:${p}`);
      return origUnlink(p);
    });
    hoisted.mockWriteFile.mockImplementation(
      async (p: string, content: string) => {
        callOrder.push(`writeFile:${p}`);
        return origWriteFile(p, content);
      },
    );
    hoisted.mockRmdir.mockImplementation(async (p: string) => {
      callOrder.push(`rmdir:${p}`);
      return origRmdir(p);
    });

    await pruneInvestigation(investigationDir, () => true);

    // 1. Per-chat files deleted first
    const unlinkIdx = callOrder.findIndex((c) => c.startsWith("unlink:"));
    // 2. Index rewritten before directory cleanup
    const indexWriteIdx = callOrder.findIndex((c) => c.includes("index.jsonl"));
    const rmdirIdx = callOrder.findIndex((c) => c.startsWith("rmdir:"));

    expect(unlinkIdx).toBeLessThan(indexWriteIdx);
    expect(indexWriteIdx).toBeLessThan(rmdirIdx);
  });
});

describe("deleteInvestigation", () => {
  it("deletes directory recursively", async () => {
    await deleteInvestigation("/logs/inv-9");
    expect(hoisted.mockRm).toHaveBeenCalledWith("/logs/inv-9", {
      recursive: true,
      force: true,
    });
  });
});
