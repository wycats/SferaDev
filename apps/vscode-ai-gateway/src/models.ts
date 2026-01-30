import type { LanguageModelChatInformation, Memento } from "vscode";
import { ConfigService } from "./config";
import { MODELS_CACHE_TTL_MS, MODELS_ENDPOINT } from "./constants";
import { logger } from "./logger";
import { ModelFilter } from "./models/filter";
import { parseModelIdentity } from "./models/identity";

export interface Model {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  name: string;
  description: string;
  context_window: number;
  max_tokens: number;
  type?: string;
  tags?: string[];
  pricing: {
    input: string;
    output: string;
  };
}

interface ModelsResponse {
  data: Model[];
}

/**
 * Persistent cache structure stored in globalState.
 * Includes ETag for conditional requests and raw model data for filtering changes.
 */
interface PersistentModelsCache {
  /** Unix timestamp when the cache was last successfully fetched */
  fetchedAt: number;
  /** ETag from the server for conditional GET requests */
  etag: string | null;
  /** Raw model data from the API (before VS Code transformation) */
  rawModels: Model[];
  /** Transformed VS Code model information */
  models: LanguageModelChatInformation[];
}

const MODELS_CACHE_KEY = "vercelAiGateway.modelsCache";

export class ModelsClient {
  /** In-memory cache for fast access during the session */
  private memoryCache: PersistentModelsCache | null = null;
  /** VS Code global state for persistent storage across reloads */
  private globalState: Memento | null = null;
  /** Track if a background revalidation is in progress */
  private revalidationInProgress = false;
  private modelFilter: ModelFilter;
  private configService: ConfigService;
  /** Event callback for when models are updated */
  private onModelsUpdated: (() => void) | null = null;

  constructor(configService: ConfigService = new ConfigService()) {
    this.configService = configService;
    this.modelFilter = new ModelFilter(configService);
  }

  /**
   * Initialize persistent storage. Call this during extension activation.
   * Restores cached models from previous sessions for instant availability.
   */
  initializePersistence(
    globalState: Memento,
    onModelsUpdated?: () => void,
  ): void {
    this.globalState = globalState;
    this.onModelsUpdated = onModelsUpdated ?? null;

    // Restore cache from persistent storage
    // IMPORTANT: We re-transform from rawModels instead of using the serialized
    // models array because VS Code model objects don't survive JSON serialization
    // properly (they become plain objects without the expected interface shape)
    const cached = globalState.get<PersistentModelsCache>(MODELS_CACHE_KEY);
    if (cached?.rawModels && cached.rawModels.length > 0) {
      // Re-transform raw models to ensure proper VS Code model structure
      const models = this.transformToVSCodeModels(cached.rawModels);
      this.memoryCache = {
        ...cached,
        models,
      };
      logger.debug(
        `Restored ${models.length} models from persistent cache (re-transformed from raw)`,
      );
      return;
    }

    // Backward compatibility: fall back to cached models if rawModels are missing
    if (cached?.models && cached.models.length > 0) {
      this.memoryCache = cached;
      logger.debug(
        `Restored ${cached.models.length} models from legacy persistent cache`,
      );
    }
  }

  /**
   * Get models with stale-while-revalidate semantics.
   *
   * - Returns cached models immediately if available (even if stale)
   * - Triggers background revalidation if cache is stale
   * - Only blocks on network if no cache exists at all
   */
  async getModels(apiKey: string): Promise<LanguageModelChatInformation[]> {
    // If we have any cached models, return them immediately
    if (this.memoryCache && this.memoryCache.models.length > 0) {
      // Check if cache is stale and trigger background revalidation
      if (!this.isModelsCacheFresh() && !this.revalidationInProgress) {
        this.revalidateInBackground(apiKey);
      }
      return this.memoryCache.models;
    }

    // No cache at all - must fetch synchronously
    const startTime = Date.now();
    const url = `${this.configService.endpoint}${MODELS_ENDPOINT}`;
    logger.info(`Fetching models from ${url} (no cache available)`);

    try {
      const result = await this.fetchModels(apiKey, null);
      if (result) {
        const models = this.transformToVSCodeModels(result.rawModels);
        logger.info(
          `Models fetched in ${Date.now() - startTime}ms, count: ${models.length}`,
        );
        await this.updateCache(result.rawModels, models, result.etag);
        return models;
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(`Failed to fetch models: ${errorMessage}`);
    }

    // Fetch failed and no cache - return empty
    return [];
  }

  /**
   * Get cached models without requiring authentication.
   * Returns models from memory/persistent cache if available, empty array otherwise.
   *
   * Use this when auth is temporarily unavailable during reload to prevent
   * the model picker from flickering to empty.
   */
  getCachedModels(): LanguageModelChatInformation[] {
    if (this.memoryCache && this.memoryCache.models.length > 0) {
      logger.debug(
        `Returning ${this.memoryCache.models.length} models from cache (no auth)`,
      );
      return this.memoryCache.models;
    }
    if (this.globalState) {
      const cached = this.globalState.get<PersistentModelsCache>(MODELS_CACHE_KEY);
      if (cached?.rawModels && cached.rawModels.length > 0) {
        const models = this.transformToVSCodeModels(cached.rawModels);
        this.memoryCache = {
          ...cached,
          models,
        };
        logger.debug(
          `Hydrated ${models.length} models from persistent cache (no auth)`,
        );
        return models;
      }
      if (cached?.models && cached.models.length > 0) {
        this.memoryCache = cached;
        logger.debug(
          `Hydrated ${cached.models.length} models from legacy cache (no auth)`,
        );
        return cached.models;
      }
    }
    return [];
  }

  /**
   * Revalidate the cache in the background using stale-while-revalidate pattern.
   * Uses ETag for conditional requests to minimize bandwidth.
   */
  private async revalidateInBackground(apiKey: string): Promise<void> {
    if (this.revalidationInProgress) return;

    this.revalidationInProgress = true;
    const currentEtag = this.memoryCache?.etag ?? null;

    logger.debug("Starting background model revalidation", {
      hasEtag: !!currentEtag,
    });

    try {
      const result = await this.fetchModels(apiKey, currentEtag);

      if (result === null) {
        // 304 Not Modified - cache is still valid, just update timestamp
        if (this.memoryCache) {
          this.memoryCache.fetchedAt = Date.now();
          await this.persistCache();
          logger.debug("Models cache validated (304 Not Modified)");
        }
      } else {
        // New data received - update cache
        const models = this.transformToVSCodeModels(result.rawModels);
        const previousModels = this.memoryCache?.models ?? [];
        const previousCount = previousModels.length;
        await this.updateCache(result.rawModels, models, result.etag);
        logger.info(
          `Models cache updated: ${previousCount} -> ${models.length} models`,
        );

        // Notify listeners that models have changed
        if (
          this.onModelsUpdated &&
          this.hasModelsChanged(previousModels, models)
        ) {
          this.onModelsUpdated();
        }
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.warn(
        `Background revalidation failed: ${errorMessage} (continuing with stale cache)`,
      );
      // On error, keep using stale cache - don't clear it
    } finally {
      this.revalidationInProgress = false;
    }
  }

  /**
   * Fetch models from the API with optional ETag for conditional requests.
   * Returns null if server responds with 304 Not Modified.
   */
  private async fetchModels(
    apiKey: string,
    etag: string | null,
  ): Promise<{ rawModels: Model[]; etag: string | null } | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const headers: Record<string, string> = {};
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
      if (etag) {
        headers["If-None-Match"] = etag;
      }

      const response = await fetch(
        `${this.configService.endpoint}${MODELS_ENDPOINT}`,
        {
          headers,
          signal: controller.signal,
        },
      );

      // 304 Not Modified - cache is still valid
      if (response.status === 304) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const { data } = (await response.json()) as ModelsResponse;
      const newEtag = response.headers.get("ETag");
      const filteredData = this.modelFilter.filterModels(data);

      return { rawModels: filteredData, etag: newEtag };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Request timed out while fetching models");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Update both memory and persistent cache.
   */
  private async updateCache(
    rawModels: Model[],
    models: LanguageModelChatInformation[],
    etag: string | null,
  ): Promise<void> {
    this.memoryCache = {
      fetchedAt: Date.now(),
      etag,
      rawModels,
      models,
    };
    await this.persistCache();
  }

  /**
   * Persist the current cache to globalState for cross-session persistence.
   */
  private async persistCache(): Promise<void> {
    if (this.globalState && this.memoryCache) {
      await this.globalState.update(MODELS_CACHE_KEY, this.memoryCache);
    }
  }

  private isModelsCacheFresh(): boolean {
    return Boolean(
      this.memoryCache &&
      Date.now() - this.memoryCache.fetchedAt < MODELS_CACHE_TTL_MS,
    );
  }

  /**
   * Check if the model list has actually changed (not just refreshed).
   * Compares model IDs to avoid unnecessary UI refreshes.
   */
  private hasModelsChanged(
    previous: LanguageModelChatInformation[],
    current: LanguageModelChatInformation[],
  ): boolean {
    if (previous.length !== current.length) {
      return true;
    }
    const previousIds = new Set(previous.map((model) => model.id));
    return current.some((model) => !previousIds.has(model.id));
  }

  private transformToVSCodeModels(
    data: Model[],
  ): LanguageModelChatInformation[] {
    const imageInputTags = new Set([
      "vision",
      "image",
      "image-input",
      "file-input",
      "multimodal",
    ]);
    const toolCallingTags = new Set([
      "tool-use",
      "tool_use",
      "tool-calling",
      "function_calling",
      "function-calling",
      "function_call",
      "tools",
      "json_mode",
      "json-mode",
    ]);
    const reasoningTags = new Set([
      "reasoning",
      "o1",
      "o3",
      "extended-thinking",
      "extended_thinking",
    ]);
    const webSearchTags = new Set([
      "web-search",
      "web_search",
      "search",
      "grounding",
    ]);

    return data
      .filter(
        (model) =>
          model.type === "chat" ||
          model.type === "language" ||
          model.type === undefined,
      )
      .map((model) => {
        const identity = parseModelIdentity(model.id);
        const tags = (model.tags ?? []).map((tag) => tag.toLowerCase());
        const hasImageInput = tags.some((tag) => imageInputTags.has(tag));
        const hasToolCalling = tags.some((tag) => toolCallingTags.has(tag));
        const hasReasoning = tags.some((tag) => reasoningTags.has(tag));
        const hasWebSearch = tags.some((tag) => webSearchTags.has(tag));

        return {
          id: model.id,
          name: model.name,
          detail: "Vercel AI Gateway",
          family: identity.family,
          version: identity.version,
          maxInputTokens: model.context_window,
          maxOutputTokens: model.max_tokens,
          tooltip: model.description || "No description available.",
          capabilities: {
            // Check tags array for capabilities - only advertise what the model actually supports
            imageInput: hasImageInput || false,
            // Only advertise tool calling if explicitly supported via tags
            // Defaulting to true could cause issues with models that don't support tools
            toolCalling: hasToolCalling || false,
            reasoning: hasReasoning || false,
            webSearch: hasWebSearch || false,
          },
        };
      });
  }
}
