/**
 * Persistence store implementation.
 */

import type * as vscode from "vscode";
import { logger } from "../logger.js";
import type { PersistentStore, StoreConfig, StoredEnvelope } from "./types.js";

const LEGACY_VERSION = 0;

type LegacyLookup = {
  key: string;
  value: unknown;
};

/**
 * Persistent store backed by VS Code memento storage.
 */
export class PersistentStoreImpl<T> implements PersistentStore<T> {
  private readonly memento: vscode.Memento;
  private readonly config: StoreConfig<T>;
  private readonly scope: "global" | "workspace";

  constructor(
    memento: vscode.Memento,
    config: StoreConfig<T>,
    scope: "global" | "workspace",
  ) {
    this.memento = memento;
    this.config = config;
    this.scope = scope;
  }

  /**
   * Get current value (returns default if empty/expired/invalid).
   */
  get(): T {
    const stored = this.memento.get<unknown>(this.config.key);
    if (stored !== undefined) {
      return this.resolveStoredValue(stored, this.config.key, false);
    }

    const legacy = this.findLegacyValue();
    if (legacy) {
      return this.resolveStoredValue(legacy.value, legacy.key, true);
    }

    return this.config.defaultValue;
  }

  /**
   * Set value (persists immediately).
   */
  async set(value: T): Promise<void> {
    const prepared = this.applyMaxEntries(value);
    await this.persist(prepared);
  }

  /**
   * Update value with a transform function.
   */
  async update(fn: (current: T) => T): Promise<void> {
    const current = this.get();
    const next = fn(current);
    await this.set(next);
  }

  /**
   * Clear this store only.
   */
  async clear(): Promise<void> {
    await this.memento.update(this.config.key, undefined);
  }

  /**
   * Check if the store has valid (non-default) data.
   */
  hasData(): boolean {
    const value = this.get();
    return !this.isDefaultValue(value);
  }

  private resolveStoredValue(
    stored: unknown,
    sourceKey: string,
    isLegacy: boolean,
  ): T {
    const envelope = this.readEnvelope(stored);
    if (envelope) {
      if (envelope.version !== this.config.version) {
        logger.warn(
          `Persistence store ${this.config.key} (${this.scope}) version mismatch ` +
            `(stored=${envelope.version}, expected=${this.config.version}).`,
        );
        return this.migrateValue(
          envelope.data,
          envelope.version,
          sourceKey,
          isLegacy,
        );
      }

      if (this.isExpired(envelope)) {
        logger.warn(
          `Persistence store ${this.config.key} (${this.scope}) TTL expired.`,
        );
        return this.config.defaultValue;
      }

      if (envelope.data === undefined) {
        return this.config.defaultValue;
      }

      return envelope.data;
    }

    logger.warn(
      `Persistence store ${this.config.key} (${this.scope}) contains ` +
        `legacy or corrupted data; attempting migration.`,
    );
    return this.migrateValue(stored, LEGACY_VERSION, sourceKey, isLegacy, true);
  }

  private migrateValue(
    oldValue: unknown,
    oldVersion: number,
    sourceKey: string,
    isLegacy: boolean,
    legacyShape = false,
  ): T {
    if (!this.config.migrate) {
      if (!legacyShape) {
        logger.warn(
          `Persistence store ${this.config.key} (${this.scope}) has incompatible ` +
            `version ${oldVersion}; no migration provided.`,
        );
      } else {
        logger.warn(
          `Persistence store ${this.config.key} (${this.scope}) contains legacy data ` +
            `shape; no migration provided.`,
        );
      }
      return this.config.defaultValue;
    }

    try {
      const migrated = this.config.migrate(oldValue, oldVersion);
      if (migrated === undefined) {
        logger.warn(
          `Persistence store ${this.config.key} (${this.scope}) migration returned ` +
            `undefined; using default value.`,
        );
        return this.config.defaultValue;
      }

      const prepared = this.applyMaxEntries(migrated);
      this.persistMigrated(prepared, sourceKey, isLegacy);
      return prepared;
    } catch (error) {
      logger.warn(
        `Persistence store ${this.config.key} (${this.scope}) migration failed; ` +
          `using default value.`,
        error,
      );
      return this.config.defaultValue;
    }
  }

  private persistMigrated(
    value: T,
    sourceKey: string,
    isLegacy: boolean,
  ): void {
    this.fireAndForget(this.persist(value), "persist migrated value");
    if (isLegacy) {
      this.fireAndForget(
        this.memento.update(sourceKey, undefined),
        "remove legacy key",
      );
    }
  }

  private isExpired(envelope: StoredEnvelope<T>): boolean {
    if (!this.config.ttlMs) return false;
    return Date.now() - envelope.timestamp > this.config.ttlMs;
  }

  private readEnvelope(value: unknown): StoredEnvelope<T> | null {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (
      typeof record["version"] !== "number" ||
      typeof record["timestamp"] !== "number" ||
      !("data" in record)
    ) {
      return null;
    }
    return record as unknown as StoredEnvelope<T>;
  }

  private findLegacyValue(): LegacyLookup | null {
    const keys = this.config.legacyKeys ?? [];
    for (const key of keys) {
      const value = this.memento.get<unknown>(key);
      if (value !== undefined) {
        return { key, value };
      }
    }
    return null;
  }

  private async persist(value: T): Promise<void> {
    const envelope: StoredEnvelope<T> = {
      version: this.config.version,
      timestamp: Date.now(),
      data: value,
    };
    try {
      await this.memento.update(this.config.key, envelope);
    } catch (error) {
      logger.warn(
        `Persistence store ${this.config.key} (${this.scope}) failed to write.`,
        error,
      );
      throw error;
    }
  }

  private applyMaxEntries(value: T): T {
    if (!this.config.maxEntries) return value;

    if (!value || typeof value !== "object") {
      return value;
    }

    // Handle arrays (e.g., CalibrationState[]) - no LRU, just return as-is
    if (Array.isArray(value)) {
      return value;
    }

    const obj = value as Record<string, unknown>;

    // Check for nested { entries: Record<...> } shape (e.g., EnrichmentCacheData)
    if (
      "entries" in obj &&
      obj["entries"] &&
      typeof obj["entries"] === "object"
    ) {
      const entriesRecord = obj["entries"] as Record<string, unknown>;
      if (this.isEntriesRecord(entriesRecord)) {
        const evicted = this.evictOldestEntries(entriesRecord);
        return { ...obj, entries: evicted } as T;
      }
    }

    // Check for direct Record<string, { fetchedAt }> shape
    if (this.isEntriesRecord(obj)) {
      return this.evictOldestEntries(obj) as T;
    }

    // Shape doesn't support LRU - return as-is without warning
    return value;
  }

  private evictOldestEntries<R extends Record<string, { fetchedAt: number }>>(
    record: R,
  ): R {
    const maxEntries = this.config.maxEntries!;
    const entries = Object.entries(record);
    if (entries.length <= maxEntries) return record;

    const sorted = entries.sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    const keep = sorted.slice(entries.length - maxEntries);
    return Object.fromEntries(keep) as R;
  }

  private isEntriesRecord(
    record: Record<string, unknown>,
  ): record is Record<string, { fetchedAt: number } & Record<string, unknown>> {
    const values = Object.values(record);
    if (values.length === 0) return true; // Empty record is valid
    return values.every((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const value = entry as Record<string, unknown>;
      return typeof value["fetchedAt"] === "number";
    });
  }

  private fireAndForget(promise: Thenable<void>, action: string): void {
    void promise.then(undefined, (error) => {
      logger.warn(
        `Persistence store ${this.config.key} (${this.scope}) failed to ${action}.`,
        error,
      );
    });
  }

  private isDefaultValue(value: T): boolean {
    if (Object.is(value, this.config.defaultValue)) return true;
    try {
      return JSON.stringify(value) === JSON.stringify(this.config.defaultValue);
    } catch {
      return false;
    }
  }
}
