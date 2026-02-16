/**
 * Unified Log Subscriber
 *
 * Writes ALL InvestigationEvents to a single JSONL file:
 *   .logs/{investigation}/events.jsonl
 *
 * This is "the one place" — given a causedByChatId from a tree change,
 * you can grep this file to see:
 *   1. agent.started (chatId = X) — when the request began
 *   2. request.index (chatId = X) — request summary with token counts
 *   3. tree.change (causedByChatId = X) — what changed in the tree
 *   4. agent.completed (chatId = X) — how the request finished
 *
 * The file is append-only JSONL, one event per line, sorted by eventId (ULID).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type {
  InvestigationEvent,
  InvestigationSubscriber,
} from "./investigation-events.js";
import { safeJsonStringify } from "../utils/serialize.js";
import { logger } from "../logger.js";

/**
 * Create a subscriber that appends every event to events.jsonl.
 *
 * The investigation name is read from config at creation time.
 * Returns null if the log directory can't be resolved.
 */
export function createUnifiedLogSubscriber(): InvestigationSubscriber | null {
  const logDir = resolveLogDirectory();
  if (!logDir) return null;

  const investigationName =
    vscode.workspace
      .getConfiguration("vercel.ai")
      .get<string>("investigation.name") ?? "default";

  const investigationDir = path.join(logDir, investigationName);

  // Ensure directory exists (sync, once at creation)
  try {
    fs.mkdirSync(investigationDir, { recursive: true });
  } catch {
    logger.warn(`[UnifiedLog] Could not create directory: ${investigationDir}`);
    return null;
  }

  const filePath = path.join(investigationDir, "events.jsonl");

  return {
    onEvent(event: InvestigationEvent): void {
      try {
        fs.appendFileSync(filePath, safeJsonStringify(event) + "\n", "utf8");
      } catch {
        // Silently fail on write errors — don't crash the extension
      }
    },
  };
}

/**
 * Resolve the investigation logs directory from workspace configuration.
 */
function resolveLogDirectory(): string | null {
  const logFileDirectory =
    vscode.workspace
      .getConfiguration("vercel.ai")
      .get<string>("logging.fileDirectory") ?? ".logs";

  if (!logFileDirectory) return null;

  if (path.isAbsolute(logFileDirectory)) {
    return logFileDirectory;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  const firstFolder = workspaceFolders?.[0];
  if (firstFolder) {
    return path.join(firstFolder.uri.fsPath, logFileDirectory);
  }

  return null;
}
