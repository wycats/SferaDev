/**
 * Core persistence interfaces for the VS Code AI Gateway.
 */

/**
 * Versioned envelope stored in VS Code memento storage.
 */
export interface StoredEnvelope<T> {
  /** Schema version of the stored data. */
  version: number;
  /** Timestamp (ms since epoch) when the data was written. */
  timestamp: number;
  /** Stored data payload. */
  data: T;
}

/**
 * Configuration for a persistent store.
 */
export interface StoreConfig<T> {
  /** Unique key for this store. */
  key: string;
  /** Schema version — increment when the data shape changes. */
  version: number;
  /** Scope determines which VS Code storage is used. */
  scope: "global" | "workspace";
  /** Default value when the store is empty or invalid. */
  defaultValue: T;
  /** Optional migration function for older versions. */
  migrate?: (oldValue: unknown, oldVersion: number) => T;
  /** Optional TTL in milliseconds. */
  ttlMs?: number;
  /** Optional max entries for LRU eviction. */
  maxEntries?: number;
  /** Optional legacy keys to read from. */
  legacyKeys?: string[];
}

/**
 * Store interface for reading and writing persisted data.
 */
export interface PersistentStore<T> {
  /** Get current value (returns default if empty/expired/invalid). */
  get(): T;
  /** Set value (persists immediately). */
  set(value: T): Promise<void>;
  /** Update value with a transform function. */
  update(fn: (current: T) => T): Promise<void>;
  /** Clear this store only. */
  clear(): Promise<void>;
  /** Check if the store has valid (non-default) data. */
  hasData(): boolean;
}

/**
 * Manager interface for persistence stores.
 */
export interface PersistenceManager {
  /**
   * Get a scoped store for a specific data type.
   */
  getStore<T>(config: StoreConfig<T>): PersistentStore<T>;
  /**
   * Clear all persisted data (for testing/reset).
   */
  clearAll(): Promise<void>;
}
