import * as fs from "node:fs";
import * as path from "node:path";

import type { ErrorIndexEntry } from "./error-capture.js";
import { logger } from "../logger.js";
import { safeJsonStringify } from "../utils/serialize.js";
import { sanitizePathSegment } from "./investigation.js";

export interface ErrorPruneResult {
  entriesRemoved: number;
  filesDeleted: number;
  bytesFreed: number;
}

const MS_PER_DAY = 86_400_000;
const DEFAULT_MAX_AGE_DAYS = 90;
const DEFAULT_MAX_SIZE_BYTES = 50 * 1024 * 1024;

function isMissingFileError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}

function parseIndexEntries(content: string): ErrorIndexEntry[] {
  const entries: ErrorIndexEntry[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed) as ErrorIndexEntry;
      entries.push(parsed);
    } catch {
      continue;
    }
  }

  return entries;
}

function formatJsonl(entries: readonly ErrorIndexEntry[]): string {
  if (entries.length === 0) {
    return "";
  }

  return `${entries.map((entry) => safeJsonStringify(entry)).join("\n")}\n`;
}

function getEntryTimestamp(entry: ErrorIndexEntry): number | null {
  const parsed = new Date(entry.ts);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.getTime();
}

async function deleteFileIfExists(filePath: string): Promise<{
  deleted: boolean;
  bytes: number;
}> {
  try {
    const stats = await fs.promises.stat(filePath);
    await fs.promises.unlink(filePath);
    return { deleted: true, bytes: stats.size };
  } catch (err) {
    if (isMissingFileError(err)) {
      return { deleted: false, bytes: 0 };
    }
    throw err;
  }
}

async function deleteErrorFiles(
  errorsDir: string,
  entry: ErrorIndexEntry,
): Promise<{ filesDeleted: number; bytesFreed: number }> {
  const dateDir = entry.ts.slice(0, 10);
  const safeChatId = sanitizePathSegment(entry.chatId);
  const dayDir = path.join(errorsDir, dateDir);
  const jsonPath = path.join(dayDir, `${safeChatId}.json`);
  const ssePath = path.join(dayDir, `${safeChatId}.sse.jsonl`);

  let filesDeleted = 0;
  let bytesFreed = 0;

  const jsonResult = await deleteFileIfExists(jsonPath);
  if (jsonResult.deleted) {
    filesDeleted += 1;
    bytesFreed += jsonResult.bytes;
  }

  const sseResult = await deleteFileIfExists(ssePath);
  if (sseResult.deleted) {
    filesDeleted += 1;
    bytesFreed += sseResult.bytes;
  }

  return { filesDeleted, bytesFreed };
}

async function removeEmptyDateDirs(
  errorsDir: string,
  entries: readonly ErrorIndexEntry[],
): Promise<void> {
  const dates = new Set<string>(entries.map((entry) => entry.ts.slice(0, 10)));

  for (const date of dates) {
    const dayDir = path.join(errorsDir, date);
    try {
      const dayEntries = await fs.promises.readdir(dayDir);
      if (dayEntries.length === 0) {
        await fs.promises.rmdir(dayDir);
      }
    } catch (err) {
      if (!isMissingFileError(err)) {
        throw err;
      }
    }
  }
}

export async function calculateDirectorySize(dir: string): Promise<number> {
  try {
    const entries = await fs.promises.readdir(dir, {
      withFileTypes: true,
      recursive: true,
    });

    let totalSize = 0;
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const entryPath = path.join(entry.parentPath, entry.name);
      try {
        const stats = await fs.promises.stat(entryPath);
        totalSize += stats.size;
      } catch (err) {
        if (!isMissingFileError(err)) {
          throw err;
        }
      }
    }

    return totalSize;
  } catch (err) {
    if (isMissingFileError(err)) {
      return 0;
    }
    throw err;
  }
}

export async function pruneErrorLogs(
  errorsDir: string,
  options?: { maxAgeDays?: number; maxSizeBytes?: number },
): Promise<ErrorPruneResult> {
  const result: ErrorPruneResult = {
    entriesRemoved: 0,
    filesDeleted: 0,
    bytesFreed: 0,
  };

  const maxAgeDays = options?.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const maxSizeBytes = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const indexPath = path.join(errorsDir, "index.jsonl");

  let indexContent: string;
  try {
    indexContent = await fs.promises.readFile(indexPath, "utf8");
  } catch (err) {
    if (isMissingFileError(err)) {
      return result;
    }
    throw err;
  }

  const entries = parseIndexEntries(indexContent);
  if (entries.length === 0) {
    return result;
  }

  const cutoffMs = Date.now() - maxAgeDays * MS_PER_DAY;
  const keptEntries: ErrorIndexEntry[] = [];
  const removedEntries: ErrorIndexEntry[] = [];

  for (const entry of entries) {
    const timestamp = getEntryTimestamp(entry);
    const isOld = timestamp !== null && timestamp < cutoffMs;
    if (isOld) {
      removedEntries.push(entry);
    } else {
      keptEntries.push(entry);
    }
  }

  if (removedEntries.length > 0) {
    for (const entry of removedEntries) {
      const deletion = await deleteErrorFiles(errorsDir, entry);
      result.filesDeleted += deletion.filesDeleted;
      result.bytesFreed += deletion.bytesFreed;
      result.entriesRemoved += 1;
    }

    await fs.promises.writeFile(indexPath, formatJsonl(keptEntries), "utf8");
    await removeEmptyDateDirs(errorsDir, removedEntries);
  }

  if (keptEntries.length === 0) {
    return result;
  }

  let currentSize = await calculateDirectorySize(errorsDir);
  if (currentSize <= maxSizeBytes) {
    return result;
  }

  const sortedEntries = [...keptEntries].sort((a, b) => {
    const aTs = getEntryTimestamp(a) ?? Date.now();
    const bTs = getEntryTimestamp(b) ?? Date.now();
    return aTs - bTs;
  });

  const removedBySize: ErrorIndexEntry[] = [];

  for (const entry of sortedEntries) {
    const deletion = await deleteErrorFiles(errorsDir, entry);
    result.filesDeleted += deletion.filesDeleted;
    result.bytesFreed += deletion.bytesFreed;
    result.entriesRemoved += 1;
    removedBySize.push(entry);

    currentSize = await calculateDirectorySize(errorsDir);
    if (currentSize <= maxSizeBytes) {
      break;
    }
  }

  if (removedBySize.length === 0) {
    return result;
  }

  const removedKeys = new Set(
    removedBySize.map((entry) => `${entry.ts}:${entry.chatId}`),
  );
  const remainingEntries = keptEntries.filter(
    (entry) => !removedKeys.has(`${entry.ts}:${entry.chatId}`),
  );

  await fs.promises.writeFile(indexPath, formatJsonl(remainingEntries), "utf8");
  await removeEmptyDateDirs(errorsDir, removedBySize);

  if (remainingEntries.length === 0) {
    logger.info("[ErrorCapture] All error logs pruned by size cap");
  }

  return result;
}
