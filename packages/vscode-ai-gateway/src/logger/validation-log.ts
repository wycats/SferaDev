/**
 * Purpose-built validation logging for token count accuracy.
 *
 * Writes a single JSONL file to `.logs/token-validation.jsonl` (resolved
 * relative to the workspace root, matching the `vercel.ai.logging.fileDirectory`
 * setting).
 *
 * Each entry captures estimate vs actual for one request, with enough context
 * to diagnose drift without noise.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

export interface TokenValidationEntry {
  /** ISO timestamp */
  ts: string;
  /** Model ID */
  model: string;
  /** Chat ID for correlating multi-turn sequences */
  chatId: string;
  /** OpenResponses response ID */
  responseId: string | undefined;
  /** Prompt cache key for session continuity */
  promptCacheKey: string | undefined;

  /** Pre-request estimate from ai-tokenizer */
  estimatedInputTokens: number;
  /** Server-reported actual input tokens */
  actualInputTokens: number;
  /** Server-reported actual output tokens */
  actualOutputTokens: number;

  /** Absolute delta (estimated - actual) */
  delta: number;
  /** Percentage delta ((estimated - actual) / actual * 100) */
  deltaPct: number;
}

/**
 * Resolve the .logs directory from workspace settings.
 * Returns null if no workspace folder is open.
 */
function getLogDirectory(): string | null {
  const config = vscode.workspace.getConfiguration("vercel.ai.logging");
  const fileDir = config.get<string>("fileDirectory", ".logs");

  if (path.isAbsolute(fileDir)) {
    return fileDir;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  const firstFolder = workspaceFolders?.[0];
  if (firstFolder) {
    return path.join(firstFolder.uri.fsPath, fileDir);
  }

  return null;
}

/**
 * Write a token validation entry to `.logs/token-validation.jsonl`.
 *
 * Fails silently — validation logging must never break the extension.
 */
export function writeTokenValidationEntry(
  entry: Omit<TokenValidationEntry, "ts" | "delta" | "deltaPct">,
): void {
  const logDir = getLogDirectory();
  if (!logDir) return;

  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const actual = entry.actualInputTokens;
    const delta = entry.estimatedInputTokens - actual;
    const deltaPct = actual > 0 ? (delta / actual) * 100 : 0;

    const full: TokenValidationEntry = {
      ...entry,
      ts: new Date().toISOString(),
      delta,
      deltaPct: Math.round(deltaPct * 10) / 10,
    };

    const logPath = path.join(logDir, "token-validation.jsonl");
    fs.appendFileSync(logPath, JSON.stringify(full) + "\n");
  } catch {
    // Silently fail — validation logging is observational only
  }
}
