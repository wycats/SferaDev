import type * as vscode from "vscode";
import { logger } from "../logger";
import { computeNormalizedDigest } from "../utils/digest";

export interface CachedTokenCount {
  digest: string;
  modelFamily: string;
  actualTokens: number;
  timestamp: number;
}

interface PersistedTokenCache {
  version: number;
  timestamp: number;
  entries: Array<{
    key: string;
    entry: CachedTokenCount;
  }>;
}

const STORAGE_KEY = "tokenCache.v1";
const STORAGE_VERSION = 1;
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 2000;
const SAVE_DEBOUNCE_MS = 1000;

export class TokenCache {
  private cache = new Map<string, CachedTokenCount>();
  private accessOrder: string[] = [];
  private readonly memento: vscode.Memento | undefined;
  private saveDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(memento?: vscode.Memento) {
    this.memento = memento;
    if (memento) {
      this.loadFromStorage();
    }
  }

  getCached(
    message: vscode.LanguageModelChatMessage,
    modelFamily: string,
  ): number | undefined {
    const digest = computeNormalizedDigest(message);
    const key = this.cacheKey(modelFamily, digest);
    const cached = this.cache.get(key);
    if (cached) {
      const age = Date.now() - cached.timestamp;
      if (age > TTL_MS) {
        this.cache.delete(key);
        this.accessOrder = this.accessOrder.filter(
          (accessKey) => accessKey !== key,
        );
        logger.trace(
          `Token cache entry expired for message (family: ${modelFamily})`,
        );
        return undefined;
      }
      this.touchKey(key);
      logger.trace(
        `Token cache hit for message (family: ${modelFamily}): ${cached.actualTokens.toString()} tokens`,
      );
      return cached.actualTokens;
    }
    logger.trace(`Token cache miss for message (family: ${modelFamily})`);
    return undefined;
  }

  cacheActual(
    message: vscode.LanguageModelChatMessage,
    modelFamily: string,
    actualTokens: number,
  ): void {
    const digest = computeNormalizedDigest(message);
    const key = this.cacheKey(modelFamily, digest);
    const existed = this.cache.has(key);
    this.touchKey(key);
    if (!existed) {
      this.evictIfNeeded(key);
    }
    this.cache.set(key, {
      digest,
      modelFamily,
      actualTokens,
      timestamp: Date.now(),
    });
    this.scheduleSave();
    logger.trace(
      `Cached actual token count: ${actualTokens.toString()} (family: ${modelFamily})`,
    );
  }

  private cacheKey(modelFamily: string, digest: string): string {
    return `${modelFamily}:${digest}`;
  }

  private touchKey(key: string): void {
    const index = this.accessOrder.indexOf(key);
    if (index !== -1) {
      this.accessOrder.splice(index, 1);
    }
    this.accessOrder.push(key);
  }

  private evictIfNeeded(key: string): void {
    // Called BEFORE cache.set, so we need >= to make room for the new entry
    while (this.cache.size >= MAX_ENTRIES) {
      const oldest = this.accessOrder.shift();
      if (!oldest) {
        break;
      }
      if (!this.cache.has(oldest)) {
        continue;
      }
      if (oldest === key) {
        continue;
      }
      this.cache.delete(oldest);
      break;
    }
  }

  private loadFromStorage(): void {
    if (!this.memento) return;

    try {
      const stored = this.memento.get<PersistedTokenCache>(STORAGE_KEY);
      if (!stored || stored.version !== STORAGE_VERSION) {
        logger.debug("[TokenCache] No valid stored state found");
        return;
      }

      const now = Date.now();
      let loadedCount = 0;
      for (const entry of stored.entries) {
        if (now - entry.entry.timestamp <= TTL_MS) {
          this.cache.set(entry.key, entry.entry);
          this.accessOrder.push(entry.key);
          loadedCount++;
        }
      }

      // Evict oldest entries if we exceeded MAX_ENTRIES after loading
      while (this.cache.size > MAX_ENTRIES) {
        const oldest = this.accessOrder.shift();
        if (oldest) {
          this.cache.delete(oldest);
        }
      }

      logger.info(
        `[TokenCache] Loaded ${loadedCount.toString()} entries from storage`,
      );
    } catch (error) {
      logger.warn("[TokenCache] Failed to load from storage", error);
    }
  }

  private scheduleSave(): void {
    if (!this.memento) return;

    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(() => {
      void this.saveToStorage();
    }, SAVE_DEBOUNCE_MS);
  }

  private async saveToStorage(): Promise<void> {
    if (!this.memento) return;

    try {
      const entries: PersistedTokenCache["entries"] = [];
      for (const key of this.accessOrder) {
        const entry = this.cache.get(key);
        if (entry) {
          entries.push({ key, entry });
        }
      }

      const persisted: PersistedTokenCache = {
        version: STORAGE_VERSION,
        timestamp: Date.now(),
        entries,
      };

      await this.memento.update(STORAGE_KEY, persisted);
      logger.debug(
        `[TokenCache] Saved ${entries.length.toString()} entries to storage`,
      );
    } catch (error) {
      logger.warn("[TokenCache] Failed to save to storage", error);
    }
  }
}
