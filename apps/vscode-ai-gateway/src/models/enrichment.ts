import type * as vscode from "vscode";
import { ConfigService } from "../config";
import { ENRICHMENT_CACHE_TTL_MS, ENRICHMENT_ENDPOINT_PATTERN } from "../constants";
import { logger } from "../logger";
import { parseModelIdentity } from "./identity";

const ENRICHMENT_CACHE_KEY = "vercelAiGateway.enrichmentCache";

export interface EnrichmentResponse {
	data: {
		id: string;
		name: string;
		description?: string;
		architecture?: {
			modality?: string;
			input_modalities?: string[];
			output_modalities?: string[];
		};
		endpoints: ModelEndpoint[];
	};
}

export interface ModelEndpoint {
	name?: string;
	context_length?: number;
	max_completion_tokens?: number;
	supported_parameters?: string[];
	supports_implicit_caching?: boolean;
}

export interface EnrichedModelData {
	context_length: number | null;
	max_completion_tokens: number | null;
	supported_parameters: string[];
	supports_implicit_caching: boolean;
	/** Input modalities supported by the model (e.g., ["text", "image"]) */
	input_modalities: string[];
}

interface EnrichmentCacheEntry {
	fetchedAt: number;
	data: EnrichedModelData | null;
}

/** Serializable format for persistent storage */
interface PersistedEnrichmentCache {
	version: 1;
	entries: Record<string, EnrichmentCacheEntry>;
}

export function extractCreatorAndModel(modelId: string): { creator: string; model: string } | null {
	if (!modelId) return null;

	if (modelId.includes(":")) {
		const { provider, family } = parseModelIdentity(modelId);
		if (!provider || !family) return null;
		return { creator: provider, model: family };
	}

	if (modelId.includes("/")) {
		const [creator, model] = modelId.split("/");
		if (creator && model) return { creator, model };
	}

	return null;
}

export class ModelEnricher {
	private cache = new Map<string, EnrichmentCacheEntry>();
	private configService: ConfigService;
	private globalState: vscode.Memento | null = null;
	private persistenceLoaded = false;

	constructor(configService: ConfigService = new ConfigService()) {
		this.configService = configService;
	}

	/**
	 * Initialize with extension context for persistent caching.
	 * Call this on extension activation to restore cache from previous session.
	 */
	initializePersistence(globalState: vscode.Memento): void {
		this.globalState = globalState;
		this.loadFromPersistence();
	}

	private loadFromPersistence(): void {
		if (!this.globalState || this.persistenceLoaded) return;

		try {
			const persisted = this.globalState.get<PersistedEnrichmentCache>(ENRICHMENT_CACHE_KEY);
			if (persisted?.version === 1 && persisted.entries) {
				for (const [modelId, entry] of Object.entries(persisted.entries)) {
					// Only restore entries that haven't expired
					if (Date.now() - entry.fetchedAt < ENRICHMENT_CACHE_TTL_MS) {
						this.cache.set(modelId, entry);
					}
				}
				logger.debug(`Restored ${this.cache.size} enrichment cache entries from storage`);
			}
		} catch (error) {
			logger.warn("Failed to load enrichment cache from storage", error);
		}
		this.persistenceLoaded = true;
	}

	private async persistToStorage(): Promise<void> {
		if (!this.globalState) return;

		try {
			const entries: Record<string, EnrichmentCacheEntry> = {};
			for (const [modelId, entry] of this.cache.entries()) {
				entries[modelId] = entry;
			}
			const persisted: PersistedEnrichmentCache = { version: 1, entries };
			await this.globalState.update(ENRICHMENT_CACHE_KEY, persisted);
		} catch (error) {
			logger.warn("Failed to persist enrichment cache to storage", error);
		}
	}

	async enrichModel(modelId: string, apiKey: string): Promise<EnrichedModelData | null> {
		logger.trace(`Checking enrichment cache for ${modelId}`);
		const cached = this.cache.get(modelId);
		if (cached && Date.now() - cached.fetchedAt < ENRICHMENT_CACHE_TTL_MS) {
			logger.debug(`Enrichment cache hit for ${modelId}`);
			return cached.data;
		}

		logger.debug(`Enrichment cache miss for ${modelId}, fetching...`);
		if (cached) {
			this.cache.delete(modelId);
		}

		const parsed = extractCreatorAndModel(modelId);
		if (!parsed) {
			logger.warn(`Unable to extract creator/model from model id: ${modelId}`);
			return null;
		}

		const { creator, model } = parsed;
		const url = `${this.configService.endpoint}${ENRICHMENT_ENDPOINT_PATTERN}/${encodeURIComponent(
			creator,
		)}/${encodeURIComponent(model)}/endpoints`;

		const startTime = Date.now();
		try {
			const response = await fetch(url, {
				headers: apiKey
					? {
							Authorization: `Bearer ${apiKey}`,
						}
					: {},
			});

			if (!response.ok) {
				if (response.status === 404) {
					logger.warn(`Enrichment endpoint returned 404 for ${modelId}`);
					const entry = { fetchedAt: Date.now(), data: null };
					this.cache.set(modelId, entry);
					await this.persistToStorage();
					return null;
				}

				logger.warn(
					`Enrichment endpoint failed for ${modelId}: HTTP ${response.status} ${response.statusText}`,
				);
				return null;
			}

			const body = (await response.json()) as EnrichmentResponse;
			const endpoint = body?.data?.endpoints?.[0];
			if (!endpoint) {
				logger.warn(`No endpoints returned for ${modelId}`);
				const entry = { fetchedAt: Date.now(), data: null };
				this.cache.set(modelId, entry);
				await this.persistToStorage();
				return null;
			}

			const data: EnrichedModelData = {
				context_length: endpoint.context_length ?? null,
				max_completion_tokens: endpoint.max_completion_tokens ?? null,
				supported_parameters: endpoint.supported_parameters ?? [],
				supports_implicit_caching: endpoint.supports_implicit_caching ?? false,
				input_modalities: body.data.architecture?.input_modalities ?? [],
			};

			this.cache.set(modelId, { fetchedAt: Date.now(), data });
			// Persist to storage for faster startup next session
			await this.persistToStorage();
			logger.info(`Enriched ${modelId} in ${Date.now() - startTime}ms`);
			return data;
		} catch (error) {
			logger.warn(`Failed to fetch enrichment for ${modelId}`, error);
			return null;
		}
	}

	/**
	 * Clear all cached enrichment data (both in-memory and persisted).
	 */
	async clearCache(): Promise<void> {
		this.cache.clear();
		if (this.globalState) {
			await this.globalState.update(ENRICHMENT_CACHE_KEY, undefined);
		}
		logger.debug("Enrichment cache cleared");
	}
}
