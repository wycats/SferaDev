import * as fs from "node:fs";
import * as path from "node:path";

import type { IndexEntry } from "./investigation.js";
import { safeJsonStringify } from "../utils/serialize.js";

/** Stats for a discovered investigation directory */
export interface InvestigationStats {
  name: string;
  entryCount: number;
  conversationCount: number;
  oldestEntry: Date | null;
  newestEntry: Date | null;
}

/** Result of a prune operation */
export interface PruneResult {
  entriesRemoved: number;
  filesDeleted: number;
  conversationsAffected: number;
}

function parseDate(value: string): Date | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function isMissingFileError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}

async function unlinkIfExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.unlink(filePath);
    return true;
  } catch (err) {
    if (isMissingFileError(err)) {
      return false;
    }
    throw err;
  }
}

/**
 * List all investigation directories under the log root.
 * Reads each index.jsonl to compute stats.
 * Skips directories without valid index.jsonl.
 */
export async function listInvestigations(
  logDir: string,
): Promise<InvestigationStats[]> {
  const dirEntries = await fs.promises.readdir(logDir, { withFileTypes: true });
  const investigations: InvestigationStats[] = [];

  for (const entry of dirEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const indexPath = path.join(logDir, entry.name, "index.jsonl");
    let content: string;
    try {
      content = await fs.promises.readFile(indexPath, "utf8");
    } catch {
      continue;
    }

    const entries = parseIndexEntries(content);
    if (entries.length === 0 && content.trim().length > 0) {
      continue;
    }

    const firstEntry = entries[0];
    const lastEntry = entries[entries.length - 1];
    const oldestEntry = firstEntry ? parseDate(firstEntry.ts) : null;
    const newestEntry = lastEntry ? parseDate(lastEntry.ts) : null;
    const conversationCount = new Set(
      entries.map((entryItem) => entryItem.conversationId),
    ).size;

    investigations.push({
      name: entry.name,
      entryCount: entries.length,
      conversationCount,
      oldestEntry,
      newestEntry,
    });
  }

  return investigations;
}

/**
 * Parse index.jsonl lines into IndexEntry objects.
 * Skips malformed lines gracefully.
 */
export function parseIndexEntries(content: string): IndexEntry[] {
  const entries: IndexEntry[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed) as IndexEntry;
      entries.push(parsed);
    } catch {
      continue;
    }
  }

  return entries;
}

function formatJsonl(entries: readonly unknown[]): string {
  if (entries.length === 0) {
    return "";
  }
  return `${entries.map((entry) => safeJsonStringify(entry)).join("\n")}\n`;
}

async function rewriteJsonlOrRemove(
  filePath: string,
  entries: readonly unknown[],
): Promise<boolean> {
  if (entries.length === 0) {
    return unlinkIfExists(filePath);
  }

  const content = formatJsonl(entries);
  await fs.promises.writeFile(filePath, content, "utf8");
  return false;
}

async function readJsonlEntries(filePath: string): Promise<unknown[] | null> {
  try {
    const content = await fs.promises.readFile(filePath, "utf8");
    const parsed: unknown[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        parsed.push(JSON.parse(trimmed));
      } catch {
        continue;
      }
    }
    return parsed;
  } catch (err) {
    if (isMissingFileError(err)) {
      return null;
    }
    throw err;
  }
}

/**
 * Spider-delete entries from an investigation.
 *
 * Algorithm (RFC 00065 specified order):
 * 1. Read index.jsonl, partition into keep/remove by predicate
 * 2. For each removed entry: delete messages/{{chatId}}.json and messages/{{chatId}}.sse.jsonl
 * 3. Rewrite messages.jsonl for affected conversations (filter out removed chatIds)
 * 4. Rewrite index.jsonl with only kept entries
 * 5. Remove empty conversation directories
 *
 * @param investigationDir - absolute path to the investigation directory
 * @param shouldRemove - predicate: return true for entries to DELETE
 * @returns PruneResult with counts
 */
export async function pruneInvestigation(
  investigationDir: string,
  shouldRemove: (entry: IndexEntry) => boolean,
): Promise<PruneResult> {
  const indexPath = path.join(investigationDir, "index.jsonl");
  const indexContent = await fs.promises.readFile(indexPath, "utf8");
  const entries = parseIndexEntries(indexContent);

  if (entries.length === 0) {
    return { entriesRemoved: 0, filesDeleted: 0, conversationsAffected: 0 };
  }

  const keptEntries: IndexEntry[] = [];
  const removedEntries: IndexEntry[] = [];

  for (const entry of entries) {
    if (shouldRemove(entry)) {
      removedEntries.push(entry);
    } else {
      keptEntries.push(entry);
    }
  }

  if (removedEntries.length === 0) {
    return { entriesRemoved: 0, filesDeleted: 0, conversationsAffected: 0 };
  }

  const removedByConversation = new Map<string, Set<string>>();
  let filesDeleted = 0;

  for (const entry of removedEntries) {
    let chatIds = removedByConversation.get(entry.conversationId);
    if (!chatIds) {
      chatIds = new Set<string>();
      removedByConversation.set(entry.conversationId, chatIds);
    }
    chatIds.add(entry.chatId);

    const messagesDir = path.join(
      investigationDir,
      entry.conversationId,
      "messages",
    );
    const chatJsonPath = path.join(messagesDir, `${entry.chatId}.json`);
    const chatSsePath = path.join(messagesDir, `${entry.chatId}.sse.jsonl`);

    if (await unlinkIfExists(chatJsonPath)) {
      filesDeleted += 1;
    }
    if (await unlinkIfExists(chatSsePath)) {
      filesDeleted += 1;
    }
  }

  for (const [conversationId, chatIds] of removedByConversation.entries()) {
    const conversationDir = path.join(investigationDir, conversationId);
    const messagesPath = path.join(conversationDir, "messages.jsonl");
    const messagesEntries = await readJsonlEntries(messagesPath);

    if (messagesEntries) {
      const filteredEntries = messagesEntries.filter((entry) => {
        if (typeof entry === "object" && entry !== null && "chatId" in entry) {
          const chatId = (entry as { chatId?: string }).chatId;
          if (chatId && chatIds.has(chatId)) {
            return false;
          }
        }
        return true;
      });

      if (await rewriteJsonlOrRemove(messagesPath, filteredEntries)) {
        filesDeleted += 1;
      }
    }
  }

  // Step 3 (RFC 00065): Rewrite index.jsonl with kept entries only
  if (await rewriteJsonlOrRemove(indexPath, keptEntries)) {
    filesDeleted += 1;
  }

  // Step 4 (RFC 00065): Remove empty conversation directories
  for (const conversationId of removedByConversation.keys()) {
    const conversationDir = path.join(investigationDir, conversationId);

    const messagesDir = path.join(conversationDir, "messages");
    try {
      const messageFiles = await fs.promises.readdir(messagesDir);
      if (messageFiles.length === 0) {
        await fs.promises.rmdir(messagesDir);
      }
    } catch (err) {
      if (!isMissingFileError(err)) {
        throw err;
      }
    }

    try {
      const conversationEntries = await fs.promises.readdir(conversationDir);
      if (conversationEntries.length === 0) {
        await fs.promises.rmdir(conversationDir);
      }
    } catch (err) {
      if (!isMissingFileError(err)) {
        throw err;
      }
    }
  }

  // Cleanup: remove investigation dir if completely empty
  try {
    const remainingEntries = await fs.promises.readdir(investigationDir);
    if (remainingEntries.length === 0) {
      await fs.promises.rmdir(investigationDir);
    }
  } catch (err) {
    if (!isMissingFileError(err)) {
      throw err;
    }
  }

  return {
    entriesRemoved: removedEntries.length,
    filesDeleted,
    conversationsAffected: removedByConversation.size,
  };
}

/**
 * Delete an entire investigation directory recursively.
 */
export async function deleteInvestigation(
  investigationDir: string,
): Promise<void> {
  await fs.promises.rm(investigationDir, { recursive: true, force: true });
}
