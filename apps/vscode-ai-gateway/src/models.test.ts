import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Model, ModelsClient } from "./models";

describe("ModelsClient", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("parses family/version and uses full context window", async () => {
		const models: Model[] = [
			{
				id: "openai:gpt-4o-2024-11-20",
				object: "model",
				created: 0,
				owned_by: "openai",
				name: "GPT-4o",
				description: "Latest GPT-4o model",
				context_window: 128000,
				max_tokens: 4096,
				type: "chat",
				tags: ["vision", "function_calling", "json_mode"],
				pricing: {
					input: "0",
					output: "0",
				},
			},
		];

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ data: models }),
		});

		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const client = new ModelsClient();
		const result = await client.getModels("test-api-key");

		expect(result).toHaveLength(1);
		expect(result[0].family).toBe("gpt-4o");
		expect(result[0].version).toBe("2024-11-20");
		expect(result[0].maxInputTokens).toBe(128000);
		expect(result[0].capabilities.imageInput).toBe(true);
		expect(result[0].capabilities.toolCalling).toBe(true);
	});

	it("filters out non-chat models and keeps undefined types", async () => {
		const models: Model[] = [
			{
				id: "openai:gpt-4o-2024-11-20",
				object: "model",
				created: 0,
				owned_by: "openai",
				name: "GPT-4o",
				description: "Latest GPT-4o model",
				context_window: 128000,
				max_tokens: 4096,
				type: "chat",
				tags: [],
				pricing: {
					input: "0",
					output: "0",
				},
			},
			{
				id: "openai:text-embedding-3-large",
				object: "model",
				created: 0,
				owned_by: "openai",
				name: "Embedding 3 Large",
				description: "Embedding model",
				context_window: 8192,
				max_tokens: 2048,
				type: "embedding",
				tags: [],
				pricing: {
					input: "0",
					output: "0",
				},
			},
			{
				id: "anthropic:claude-3-opus-20240229",
				object: "model",
				created: 0,
				owned_by: "anthropic",
				name: "Claude 3 Opus",
				description: "Claude 3 Opus",
				context_window: 200000,
				max_tokens: 4096,
				type: undefined as unknown as string,
				tags: [],
				pricing: {
					input: "0",
					output: "0",
				},
			},
		];

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ data: models }),
		});

		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const client = new ModelsClient();
		const result = await client.getModels("test-api-key");

		expect(result).toHaveLength(2);
		expect(result.map((model) => model.id)).toEqual([
			"openai:gpt-4o-2024-11-20",
			"anthropic:claude-3-opus-20240229",
		]);
	});
});
