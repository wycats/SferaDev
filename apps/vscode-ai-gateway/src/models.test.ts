import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
	const mockGetConfiguration = vi.fn();
	const mockOnDidChangeConfiguration = vi.fn(
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		(_callback?: unknown) => ({ dispose: vi.fn() }),
	);

	// Mock EventEmitter class - must be inside hoisted
	class MockEventEmitter {
		private listeners: Set<(...args: unknown[]) => void> = new Set();
		event = (listener: (...args: unknown[]) => void) => {
			this.listeners.add(listener);
			return { dispose: () => this.listeners.delete(listener) };
		};
		fire = (...args: unknown[]) => {
			for (const listener of this.listeners) listener(...args);
		};
		dispose = () => {
			this.listeners.clear();
		};
	}

	return {
		mockGetConfiguration,
		mockOnDidChangeConfiguration,
		MockEventEmitter,
	};
});

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: hoisted.mockGetConfiguration,
		onDidChangeConfiguration: hoisted.mockOnDidChangeConfiguration,
	},
	EventEmitter: hoisted.MockEventEmitter,
}));

import { type Model, ModelsClient } from "./models";

describe("ModelsClient", () => {
	let originalFetch: typeof fetch;

	const reasoningTags = ["reasoning", "o1", "o3", "extended-thinking", "extended_thinking"];
	const webSearchTags = ["web-search", "web_search", "search", "grounding"];

	const baseModel: Omit<Model, "id" | "tags" | "type"> = {
		object: "model",
		created: 0,
		owned_by: "test",
		name: "Test Model",
		description: "Test",
		context_window: 8192,
		max_tokens: 2048,
		pricing: {
			input: "0",
			output: "0",
		},
	};

	const transformModels = (models: Model[]) => {
		const client = new ModelsClient();
		const transform = (
			client as unknown as {
				transformToVSCodeModels: (data: Model[]) => Array<{
					id: string;
					capabilities: { reasoning: boolean; webSearch: boolean };
				}>;
			}
		).transformToVSCodeModels;
		return transform(models);
	};

	/**
	 * Create a properly mocked fetch response with headers support
	 */
	const createMockResponse = (models: Model[], etag?: string) => ({
		ok: true,
		status: 200,
		json: async () => ({ data: models }),
		headers: {
			get: (name: string) => (name.toLowerCase() === "etag" ? (etag ?? null) : null),
		},
	});

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		vi.clearAllMocks();
		hoisted.mockGetConfiguration.mockReturnValue({
			get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
		});
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

		const mockFetch = vi.fn().mockResolvedValue(createMockResponse(models));

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

		const mockFetch = vi.fn().mockResolvedValue(createMockResponse(models));

		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const client = new ModelsClient();
		const result = await client.getModels("test-api-key");

		expect(result).toHaveLength(2);
		expect(result.map((model) => model.id)).toEqual([
			"openai:gpt-4o-2024-11-20",
			"anthropic:claude-3-opus-20240229",
		]);
	});

	it("detects reasoning and web-search capabilities from tags", async () => {
		const models: Model[] = [
			{
				id: "openai:o3-mini",
				object: "model",
				created: 0,
				owned_by: "openai",
				name: "o3-mini",
				description: "Reasoning model with web search",
				context_window: 32768,
				max_tokens: 4096,
				type: "chat",
				tags: ["o3", "web-search"],
				pricing: {
					input: "0",
					output: "0",
				},
			},
		];

		const mockFetch = vi.fn().mockResolvedValue(createMockResponse(models));

		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const client = new ModelsClient();
		const result = await client.getModels("test-api-key");

		expect(result).toHaveLength(1);
		const capabilities = result[0].capabilities as Record<string, boolean>;
		expect(capabilities.reasoning).toBe(true);
		expect(capabilities.webSearch).toBe(true);
	});

	it("filters models using allowlist config", async () => {
		hoisted.mockGetConfiguration.mockReturnValue({
			get: vi.fn((key: string, defaultValue: unknown) => {
				if (key === "models.allowlist") return ["openai:*"];
				return defaultValue;
			}),
		});

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
				id: "anthropic:claude-3-opus-20240229",
				object: "model",
				created: 0,
				owned_by: "anthropic",
				name: "Claude 3 Opus",
				description: "Claude 3 Opus",
				context_window: 200000,
				max_tokens: 4096,
				type: "chat",
				tags: [],
				pricing: {
					input: "0",
					output: "0",
				},
			},
		];

		const mockFetch = vi.fn().mockResolvedValue(createMockResponse(models));

		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const client = new ModelsClient();
		const result = await client.getModels("test-api-key");

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("openai:gpt-4o-2024-11-20");
	});

	it("filters models using denylist config", async () => {
		hoisted.mockGetConfiguration.mockReturnValue({
			get: vi.fn((key: string, defaultValue: unknown) => {
				if (key === "models.denylist") return ["anthropic:*"];
				return defaultValue;
			}),
		});

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
				id: "anthropic:claude-3-opus-20240229",
				object: "model",
				created: 0,
				owned_by: "anthropic",
				name: "Claude 3 Opus",
				description: "Claude 3 Opus",
				context_window: 200000,
				max_tokens: 4096,
				type: "chat",
				tags: [],
				pricing: {
					input: "0",
					output: "0",
				},
			},
		];

		const mockFetch = vi.fn().mockResolvedValue(createMockResponse(models));

		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const client = new ModelsClient();
		const result = await client.getModels("test-api-key");

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("openai:gpt-4o-2024-11-20");
	});

	it("returns all models when no filter config is set", async () => {
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
				id: "anthropic:claude-3-opus-20240229",
				object: "model",
				created: 0,
				owned_by: "anthropic",
				name: "Claude 3 Opus",
				description: "Claude 3 Opus",
				context_window: 200000,
				max_tokens: 4096,
				type: "chat",
				tags: [],
				pricing: {
					input: "0",
					output: "0",
				},
			},
		];

		const mockFetch = vi.fn().mockResolvedValue(createMockResponse(models));

		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const client = new ModelsClient();
		const result = await client.getModels("test-api-key");

		expect(result).toHaveLength(2);
		expect(result.map((model) => model.id)).toEqual([
			"openai:gpt-4o-2024-11-20",
			"anthropic:claude-3-opus-20240229",
		]);
	});

	describe("property-based capability detection", () => {
		it("sets reasoning when any reasoning tag is present", () => {
			fc.assert(
				fc.property(
					fc.constantFrom(...reasoningTags),
					fc.array(fc.string(), { maxLength: 4 }),
					(reasoningTag, extraTags) => {
						const models: Model[] = [
							{
								...baseModel,
								id: "openai:o3-mini",
								type: "chat",
								tags: [reasoningTag, ...extraTags],
							},
						];

						const [result] = transformModels(models);
						expect(result.capabilities.reasoning).toBe(true);
					},
				),
				{ numRuns: 50 },
			);
		});

		it("sets webSearch when any web-search tag is present", () => {
			fc.assert(
				fc.property(
					fc.constantFrom(...webSearchTags),
					fc.array(fc.string(), { maxLength: 4 }),
					(webSearchTag, extraTags) => {
						const models: Model[] = [
							{
								...baseModel,
								id: "openai:o3-mini",
								type: "chat",
								tags: [webSearchTag, ...extraTags],
							},
						];

						const [result] = transformModels(models);
						expect(result.capabilities.webSearch).toBe(true);
					},
				),
				{ numRuns: 50 },
			);
		});

		it("ignores unknown tags for reasoning/web-search", () => {
			const unknownTagArb = fc.string({ minLength: 1, maxLength: 12 }).filter((tag) => {
				const lower = tag.toLowerCase();
				return !reasoningTags.includes(lower) && !webSearchTags.includes(lower);
			});

			fc.assert(
				fc.property(fc.array(unknownTagArb, { minLength: 1, maxLength: 6 }), (tags) => {
					const models: Model[] = [
						{
							...baseModel,
							id: "openai:gpt-4o",
							type: "chat",
							tags,
						},
					];

					const [result] = transformModels(models);
					expect(result.capabilities.reasoning).toBe(false);
					expect(result.capabilities.webSearch).toBe(false);
				}),
				{ numRuns: 50 },
			);
		});
	});
});
