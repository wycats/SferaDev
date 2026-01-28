import type { LanguageModelChatInformation } from "vscode";
import { BASE_URL, MODELS_CACHE_TTL_MS, MODELS_ENDPOINT } from "./constants";
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

interface ModelsCache {
	fetchedAt: number;
	models: LanguageModelChatInformation[];
}

export class ModelsClient {
	private modelsCache?: ModelsCache;

	async getModels(apiKey: string): Promise<LanguageModelChatInformation[]> {
		if (this.isModelsCacheFresh() && this.modelsCache) {
			return this.modelsCache.models;
		}

		const data = await this.fetchModels(apiKey);
		const models = this.transformToVSCodeModels(data);

		this.modelsCache = { fetchedAt: Date.now(), models };
		return models;
	}

	private async fetchModels(apiKey: string): Promise<Model[]> {
		const response = await fetch(`${BASE_URL}${MODELS_ENDPOINT}`, {
			headers: apiKey
				? {
						Authorization: `Bearer ${apiKey}`,
					}
				: {},
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const { data } = (await response.json()) as ModelsResponse;
		return data;
	}

	private isModelsCacheFresh(): boolean {
		return Boolean(
			this.modelsCache && Date.now() - this.modelsCache.fetchedAt < MODELS_CACHE_TTL_MS,
		);
	}

	private transformToVSCodeModels(data: Model[]): LanguageModelChatInformation[] {
		const imageInputTags = new Set(["vision", "image", "image-input", "file-input", "multimodal"]);
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

		return data
			.filter((model) => model.type === "chat" || model.type === undefined)
			.map((model) => {
				const identity = parseModelIdentity(model.id);
				const tags = (model.tags ?? []).map((tag) => tag.toLowerCase());
				const hasImageInput = tags.some((tag) => imageInputTags.has(tag));
				const hasToolCalling = tags.some((tag) => toolCallingTags.has(tag));

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
					},
				};
			});
	}
}
