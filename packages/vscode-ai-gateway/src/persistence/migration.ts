/**
 * Storage key migration from vercelAiGateway.* to vercel.ai.* namespace.
 *
 * This module handles the one-time migration of persisted data when users
 * upgrade from the SferaDev extension to the Vercel-branded extension.
 *
 * Migration is idempotent - it only copies data if the new key doesn't exist
 * and the old key does. After migration, old keys are cleaned up.
 */

import type * as vscode from "vscode";
import { logger } from "../logger.js";

/**
 * Legacy storage key mappings from old namespace to new namespace.
 */
const LEGACY_KEY_MAPPINGS: ReadonlyArray<{
  oldKey: string;
  newKey: string;
  scope: "global" | "workspace";
}> = [
  // Models cache (global)
  {
    oldKey: "vercelAiGateway.modelsCache",
    newKey: "vercel.ai.modelsCache",
    scope: "global",
  },
  // Enrichment cache (global)
  {
    oldKey: "vercelAiGateway.enrichmentCache",
    newKey: "vercel.ai.enrichmentCache",
    scope: "global",
  },
  // Session stats (global) - handled by persistence layer legacyKeys
  {
    oldKey: "vercelAiGateway.sessionStats",
    newKey: "vercel.ai.sessionStats",
    scope: "global",
  },
  // Active auth session (global)
  {
    oldKey: "vercelAiGateway.activeSession",
    newKey: "vercel.ai.activeSession",
    scope: "global",
  },
  // Last selected model (workspace)
  {
    oldKey: "vercelAiGateway.lastSelectedModel",
    newKey: "vercel.ai.lastSelectedModel",
    scope: "workspace",
  },
];

/**
 * Migrate storage from old vercelAiGateway.* keys to new vercel.ai.* keys.
 *
 * This should be called early in extension activation, before any storage
 * reads occur. It's idempotent - safe to call multiple times.
 *
 * @param context - Extension context with globalState and workspaceState
 */
export async function migrateStorageKeys(
  context: vscode.ExtensionContext,
): Promise<void> {
  let migratedCount = 0;
  let cleanedCount = 0;

  for (const mapping of LEGACY_KEY_MAPPINGS) {
    const memento =
      mapping.scope === "global" ? context.globalState : context.workspaceState;

    const oldValue = memento.get<unknown>(mapping.oldKey);
    const newValue = memento.get<unknown>(mapping.newKey);

    // Only migrate if old key exists and new key doesn't
    if (oldValue !== undefined && newValue === undefined) {
      try {
        await memento.update(mapping.newKey, oldValue);
        await memento.update(mapping.oldKey, undefined);
        migratedCount++;
        logger.info(
          `Migrated storage key: ${mapping.oldKey} -> ${mapping.newKey}`,
        );
      } catch (error) {
        logger.warn(
          `Failed to migrate storage key ${mapping.oldKey}: ${String(error)}`,
        );
      }
    } else if (oldValue !== undefined && newValue !== undefined) {
      // Both exist - clean up old key (new key takes precedence)
      try {
        await memento.update(mapping.oldKey, undefined);
        cleanedCount++;
        logger.debug(
          `Cleaned up legacy storage key: ${mapping.oldKey} (new key already exists)`,
        );
      } catch (error) {
        logger.warn(
          `Failed to clean up legacy storage key ${mapping.oldKey}: ${String(error)}`,
        );
      }
    }
  }

  if (migratedCount > 0 || cleanedCount > 0) {
    logger.info(
      `Storage migration complete: ${migratedCount.toString()} migrated, ${cleanedCount.toString()} cleaned up`,
    );
  }
}
