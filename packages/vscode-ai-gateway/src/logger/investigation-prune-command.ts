import * as path from "node:path";
import * as vscode from "vscode";

import { logger } from "../logger.js";
import {
  deleteInvestigation,
  listInvestigations,
  pruneInvestigation,
} from "./investigation-prune.js";
import type { InvestigationStats } from "./investigation-prune.js";
import type { IndexEntry } from "./investigation.js";

/**
 * Resolve the investigation logs directory.
 * Duplicated from investigation.ts because it's private there.
 * (Could be extracted to shared util in a future cleanup.)
 */
function resolveLogDirectory(): string | null {
  const logFileDirectory =
    vscode.workspace
      .getConfiguration("vercel.ai")
      .get<string>("logging.fileDirectory") ?? ".logs";
  if (!logFileDirectory) return null;
  if (path.isAbsolute(logFileDirectory)) return logFileDirectory;
  const firstFolder = vscode.workspace.workspaceFolders?.[0];
  return firstFolder
    ? path.join(firstFolder.uri.fsPath, logFileDirectory)
    : null;
}

/**
 * Interactive prune command handler.
 * Shows QuickPick to select investigation, then prune mode, then confirms.
 */
export async function handlePruneCommand(): Promise<void> {
  const logDir = resolveLogDirectory();
  if (!logDir) {
    void vscode.window.showErrorMessage(
      "No workspace folder available for investigation logs.",
    );
    return;
  }

  // 1. List investigations
  let investigations: InvestigationStats[];
  try {
    investigations = await listInvestigations(logDir);
  } catch {
    void vscode.window.showErrorMessage(
      "Failed to scan investigation logs directory.",
    );
    return;
  }

  if (investigations.length === 0) {
    void vscode.window.showInformationMessage("No investigation logs found.");
    return;
  }

  // 2. Pick investigation
  interface InvestigationItem extends vscode.QuickPickItem {
    stats: InvestigationStats;
  }

  const items: InvestigationItem[] = investigations.map((inv) => {
    const dateRange =
      inv.oldestEntry && inv.newestEntry
        ? `${inv.oldestEntry.toLocaleDateString()} - ${inv.newestEntry.toLocaleDateString()}`
        : "no entries";
    return {
      label: inv.name,
      description: `${inv.entryCount} entries, ${inv.conversationCount} conversations`,
      detail: dateRange,
      stats: inv,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Select investigation to prune",
  });
  if (!picked) return;

  // 3. Pick prune mode
  const investigationDir = path.join(logDir, picked.stats.name);

  interface ModeItem extends vscode.QuickPickItem {
    mode: "all" | "1day" | "7days" | "30days";
  }

  const modeItems: ModeItem[] = [
    {
      label: "Delete all entries",
      description: "Remove entire investigation",
      mode: "all",
    },
    {
      label: "Older than 1 day",
      description: "Keep entries from the last 24 hours",
      mode: "1day",
    },
    {
      label: "Older than 7 days",
      description: "Keep entries from the last week",
      mode: "7days",
    },
    {
      label: "Older than 30 days",
      description: "Keep entries from the last month",
      mode: "30days",
    },
  ];

  const modePicked = await vscode.window.showQuickPick(modeItems, {
    placeHolder: `Prune "${picked.stats.name}" - select mode`,
  });
  if (!modePicked) return;

  // 4. Confirm
  const confirmMessage =
    modePicked.mode === "all"
      ? `Delete all ${picked.stats.entryCount} entries in "${picked.stats.name}"?`
      : `Delete entries older than ${modePicked.label.replace("Older than ", "")} in "${picked.stats.name}"?`;

  const confirmed = await vscode.window.showWarningMessage(
    confirmMessage,
    { modal: true },
    "Delete",
  );
  if (confirmed !== "Delete") return;

  // 5. Execute
  try {
    if (modePicked.mode === "all") {
      await deleteInvestigation(investigationDir);
      void vscode.window.showInformationMessage(
        `Deleted investigation "${picked.stats.name}" (${picked.stats.entryCount} entries).`,
      );
      logger.info(`[Prune] Deleted investigation "${picked.stats.name}"`);
    } else {
      const cutoffMs = {
        "1day": 24 * 60 * 60 * 1000,
        "7days": 7 * 24 * 60 * 60 * 1000,
        "30days": 30 * 24 * 60 * 60 * 1000,
      }[modePicked.mode];

      const cutoffDate = new Date(Date.now() - cutoffMs);

      const result = await pruneInvestigation(
        investigationDir,
        (entry: IndexEntry) => new Date(entry.ts) < cutoffDate,
      );

      void vscode.window.showInformationMessage(
        `Pruned ${result.entriesRemoved} entries (${result.filesDeleted} files) from "${picked.stats.name}".`,
      );
      logger.info(
        `[Prune] Pruned "${picked.stats.name}": ${result.entriesRemoved} entries, ${result.filesDeleted} files, ${result.conversationsAffected} conversations`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Prune failed: ${msg}`);
    logger.error(`[Prune] Failed: ${msg}`);
  }
}
