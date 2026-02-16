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

// ─────────────────────────────────────────────────────────────────────────────
// Interfaces — testable boundaries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Abstracts file-system operations needed by the unified log subscriber.
 *
 * Production uses real fs; tests supply an in-memory implementation.
 */
export interface EventWriter {
  /** Ensure a directory exists (like `mkdir -p`). Throws on failure. */
  ensureDir(dir: string): void;
  /** Append a line to a file. Throws on failure. */
  append(filePath: string, line: string): void;
}

/**
 * Abstracts the configuration values needed to resolve the log file path.
 *
 * Production reads from VS Code settings + workspace folders;
 * tests supply fixed values.
 */
export interface LogConfig {
  /** Base directory for logs (e.g. ".logs" or an absolute path). */
  logDirectory: string | null;
  /** Investigation subdirectory name (e.g. "default"). */
  investigationName: string;
  /** First workspace folder path, used to resolve relative logDirectory. */
  workspaceRoot: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Production defaults
// ─────────────────────────────────────────────────────────────────────────────

/** Production EventWriter backed by Node's fs module. */
export function createFsEventWriter(): EventWriter {
  return {
    ensureDir(dir: string): void {
      fs.mkdirSync(dir, { recursive: true });
    },
    append(filePath: string, line: string): void {
      fs.appendFileSync(filePath, line, "utf8");
    },
  };
}

/** Production LogConfig backed by VS Code workspace configuration. */
export function createVscodeLogConfig(): LogConfig {
  const config = vscode.workspace.getConfiguration("vercel.ai");
  return {
    logDirectory: config.get<string>("logging.fileDirectory") ?? ".logs",
    investigationName: config.get<string>("investigation.name") ?? "default",
    workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscriber factory
// ─────────────────────────────────────────────────────────────────────────────

export interface UnifiedLogSubscriberOptions {
  writer?: EventWriter;
  config?: LogConfig;
}

/**
 * Create a subscriber that appends every event to events.jsonl.
 *
 * Accepts optional `writer` and `config` for testability.
 * Production callers use the zero-arg form which supplies VS Code defaults.
 *
 * Returns null if the log directory can't be resolved (no workspace folder
 * and relative log path). Throws if the directory exists but can't be created.
 */
export function createUnifiedLogSubscriber(
  options?: UnifiedLogSubscriberOptions,
): InvestigationSubscriber | null {
  const writer = options?.writer ?? createFsEventWriter();
  const config = options?.config ?? createVscodeLogConfig();

  const logDir = resolveLogDirectory(config);
  if (!logDir) {
    logger.warn(
      `[UnifiedLog] Cannot resolve log directory (logDirectory=${String(config.logDirectory)}, workspaceRoot=${String(config.workspaceRoot)})`,
    );
    return null;
  }

  const investigationDir = path.join(logDir, config.investigationName);

  // Ensure directory exists (sync, once at creation)
  try {
    writer.ensureDir(investigationDir);
  } catch (err) {
    logger.warn(
      `[UnifiedLog] Could not create directory: ${investigationDir} — ${String(err)}`,
    );
    return null;
  }

  const filePath = path.join(investigationDir, "events.jsonl");
  logger.info(`[UnifiedLog] Writing events to ${filePath}`);

  return {
    onEvent(event: InvestigationEvent): void {
      try {
        writer.append(filePath, safeJsonStringify(event) + "\n");
      } catch {
        // Silently fail on write errors — don't crash the extension
      }
    },
  };
}

/**
 * Resolve the absolute log directory from config.
 */
function resolveLogDirectory(config: LogConfig): string | null {
  const { logDirectory, workspaceRoot } = config;

  if (!logDirectory) return null;

  if (path.isAbsolute(logDirectory)) {
    return logDirectory;
  }

  if (workspaceRoot) {
    return path.join(workspaceRoot, logDirectory);
  }

  return null;
}
