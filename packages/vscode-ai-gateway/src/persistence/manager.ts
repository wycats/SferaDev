/**
 * Persistence manager implementation.
 */

import type * as vscode from "vscode";
import type {
  PersistenceManager,
  PersistentStore,
  StoreConfig,
} from "./types.js";
import { PersistentStoreImpl } from "./store.js";

/**
 * Persistence manager backed by VS Code global and workspace state.
 */
export class PersistenceManagerImpl implements PersistenceManager {
  private readonly globalState: vscode.Memento;
  private readonly workspaceState: vscode.Memento;
  private readonly stores = new Map<string, PersistentStore<unknown>>();

  constructor(globalState: vscode.Memento, workspaceState: vscode.Memento) {
    this.globalState = globalState;
    this.workspaceState = workspaceState;
  }

  /**
   * Get a scoped store for a specific data type.
   */
  getStore<T>(config: StoreConfig<T>): PersistentStore<T> {
    const cacheKey = `${config.scope}:${config.key}`;
    const cached = this.stores.get(cacheKey) as PersistentStore<T> | undefined;
    if (cached) return cached;

    const memento =
      config.scope === "global" ? this.globalState : this.workspaceState;
    const store = new PersistentStoreImpl<T>(memento, config, config.scope);
    this.stores.set(cacheKey, store as PersistentStore<unknown>);
    return store;
  }

  /**
   * Clear all persisted data (for testing/reset).
   */
  async clearAll(): Promise<void> {
    for (const store of this.stores.values()) {
      await store.clear();
    }
  }
}
