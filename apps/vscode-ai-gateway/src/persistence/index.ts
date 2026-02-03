/**
 * Public persistence API.
 */

import type * as vscode from "vscode";
import type { PersistenceManager } from "./types.js";
import { PersistenceManagerImpl } from "./manager.js";

export * from "./types.js";
export * from "./stores.js";

/**
 * Create a persistence manager using the VS Code extension context.
 */
export function createPersistenceManager(
  context: vscode.ExtensionContext,
): PersistenceManager {
  return new PersistenceManagerImpl(
    context.globalState,
    context.workspaceState,
  );
}

/**
 * Create a mock memento for unit testing.
 */
export function createMockMemento(
  initial: Record<string, unknown> = {},
): vscode.Memento {
  const store = new Map<string, unknown>(Object.entries(initial));

  return {
    keys(): readonly string[] {
      return Array.from(store.keys());
    },
    get<T>(key: string, defaultValue?: T): T | undefined {
      if (store.has(key)) {
        return store.get(key) as T;
      }
      return defaultValue;
    },
    update(key: string, value: unknown): Thenable<void> {
      if (value === undefined) {
        store.delete(key);
      } else {
        store.set(key, value);
      }
      return Promise.resolve();
    },
  };
}
