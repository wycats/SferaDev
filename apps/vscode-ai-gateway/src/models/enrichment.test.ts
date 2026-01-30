import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, LanguageModelChatInformation } from "vscode";
import { ENRICHMENT_CACHE_TTL_MS } from "../constants";

const hoisted = vi.hoisted(() => {
	const mockGetConfiguration = vi.fn();
	const mockOnDidChangeConfiguration = vi.fn(
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		(_callback?: unknown) => ({ dispose: vi.fn() }),
	);
	const mockGetSession = vi.fn();
	const mockShowErrorMessage = vi.fn();

	class MockLanguageModelTextPart {
		constructor(public value: string) {}
	}

	class MockLanguageModelDataPart {
		constructor(
			public data: Uint8Array,
			public mimeType: string,
		) {}
	}

	class MockLanguageModelToolCallPart {
		constructor(
			public callId: string,
			public name: string,
			public input: unknown,
		) {}
	}

	class MockLanguageModelToolResultPart {
		constructor(
			public callId: string,
			public content: unknown[],
		) {}
	}

	class MockEventEmitter {
		private listeners = new Set<(...args: unknown[]) => void>();
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

	const mockOutputChannelAppendLine = vi.fn();
	const mockOutputChannelShow = vi.fn();
	const mockOutputChannelDispose = vi.fn();
	const mockCreateOutputChannel = vi.fn(() => ({
		appendLine: mockOutputChannelAppendLine,
		show: mockOutputChannelShow,
		dispose: mockOutputChannelDispose,
	}));

	return {
		mockGetConfiguration,
		mockOnDidChangeConfiguration,
		mockGetSession,
		mockShowErrorMessage,
		MockEventEmitter,
		MockLanguageModelTextPart,
		MockLanguageModelDataPart,
		MockLanguageModelToolCallPart,
		MockLanguageModelToolResultPart,
		mockCreateOutputChannel,
	};
});

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: hoisted.mockGetConfiguration,
		onDidChangeConfiguration: hoisted.mockOnDidChangeConfiguration,
	},
	window: {
		createOutputChannel: hoisted.mockCreateOutputChannel,
		showErrorMessage: hoisted.mockShowErrorMessage,
	},
	authentication: {
		getSession: hoisted.mockGetSession,
	},
	EventEmitter: hoisted.MockEventEmitter,
	LanguageModelTextPart: hoisted.MockLanguageModelTextPart,
	LanguageModelDataPart: hoisted.MockLanguageModelDataPart,
	LanguageModelToolCallPart: hoisted.MockLanguageModelToolCallPart,
	LanguageModelToolResultPart: hoisted.MockLanguageModelToolResultPart,
	LanguageModelChatMessageRole: {
		User: 1,
		Assistant: 2,
	},
	LanguageModelChatToolMode: {
		Auto: "auto",
		Required: "required",
	},
}));

import { VercelAIChatModelProvider } from "../provider";
import { type EnrichedModelData, ModelEnricher } from "./enrichment";

describe("ModelEnricher", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		vi.clearAllMocks();
		hoisted.mockGetConfiguration.mockReturnValue({
			get: vi.fn((key: string, defaultValue: unknown) => {
				if (key === "endpoint") return "https://example.test";
				if (key === "logging.level") return "off";
				if (key === "logging.outputChannel") return false;
				if (key === "models.enrichmentEnabled") return true;
				return defaultValue;
			}),
		});
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("returns enriched data for a successful response", async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				data: {
					id: "openai/gpt-4o",
					name: "GPT-4o",
					architecture: { input_modalities: ["text", "image"] },
					endpoints: [
						{
							context_length: 128000,
							max_completion_tokens: 16384,
							supported_parameters: ["max_tokens", "temperature", "tools"],
							supports_implicit_caching: true,
						},
					],
				},
			}),
		});

		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const enricher = new ModelEnricher();
		const result = await enricher.enrichModel("openai:gpt-4o-2024-11-20", "test-api-key");

		expect(result).toEqual({
			context_length: 128000,
			max_completion_tokens: 16384,
			supported_parameters: ["max_tokens", "temperature", "tools"],
			supports_implicit_caching: true,
			input_modalities: ["text", "image"],
		});
		expect(mockFetch).toHaveBeenCalledWith(
			"https://example.test/v1/models/openai/gpt-4o/endpoints",
			{
				headers: {
					Authorization: "Bearer test-api-key",
				},
			},
		);
	});

	it("uses cache within TTL and refreshes after expiration", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				data: {
					id: "openai/gpt-4o",
					name: "GPT-4o",
					endpoints: [
						{
							context_length: 128000,
							max_completion_tokens: 16384,
							supported_parameters: ["max_tokens"],
							supports_implicit_caching: false,
						},
					],
				},
			}),
		});

		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const enricher = new ModelEnricher();

		await enricher.enrichModel("openai:gpt-4o-2024-11-20", "test-api-key");
		await enricher.enrichModel("openai:gpt-4o-2024-11-20", "test-api-key");

		expect(mockFetch).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(ENRICHMENT_CACHE_TTL_MS + 1);
		await enricher.enrichModel("openai:gpt-4o-2024-11-20", "test-api-key");

		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it("returns null on 404 responses", async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 404,
			statusText: "Not Found",
		});

		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const enricher = new ModelEnricher();
		const result = await enricher.enrichModel("openai:gpt-4", "test-api-key");

		expect(result).toBeNull();
	});

	it("returns null on network errors", async () => {
		const mockFetch = vi.fn().mockRejectedValue(new Error("Network failure"));

		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const enricher = new ModelEnricher();
		const result = await enricher.enrichModel("openai:gpt-4o-2024-11-20", "test-api-key");

		expect(result).toBeNull();
	});

	it("persists cache to globalState and restores on initialization", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

		const storage = new Map<string, unknown>();
		const mockGlobalState = {
			get: vi.fn((key: string) => storage.get(key)),
			update: vi.fn(async (key: string, value: unknown) => {
				storage.set(key, value);
			}),
		};

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				data: {
					id: "openai/gpt-4o",
					name: "GPT-4o",
					architecture: { input_modalities: ["text", "image"] },
					endpoints: [
						{
							context_length: 128000,
							max_completion_tokens: 16384,
							supported_parameters: ["max_tokens"],
							supports_implicit_caching: true,
						},
					],
				},
			}),
		});

		globalThis.fetch = mockFetch as unknown as typeof fetch;

		// First enricher: fetch and persist
		const enricher1 = new ModelEnricher();
		enricher1.initializePersistence(mockGlobalState as unknown as import("vscode").Memento);
		await enricher1.enrichModel("openai:gpt-4o-2024-11-20", "test-api-key");

		expect(mockGlobalState.update).toHaveBeenCalled();

		// Second enricher: should restore from persistence without fetching
		const enricher2 = new ModelEnricher();
		enricher2.initializePersistence(mockGlobalState as unknown as import("vscode").Memento);
		const result = await enricher2.enrichModel("openai:gpt-4o-2024-11-20", "test-api-key");

		// Should only have fetched once (first enricher)
		expect(mockFetch).toHaveBeenCalledTimes(1);
		expect(result).toEqual({
			context_length: 128000,
			max_completion_tokens: 16384,
			supported_parameters: ["max_tokens"],
			supports_implicit_caching: true,
			input_modalities: ["text", "image"],
		});
	});

	it("clears cache from both memory and storage", async () => {
		const storage = new Map<string, unknown>();
		const mockGlobalState = {
			get: vi.fn((key: string) => storage.get(key)),
			update: vi.fn(async (key: string, value: unknown) => {
				if (value === undefined) {
					storage.delete(key);
				} else {
					storage.set(key, value);
				}
			}),
		};

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				data: {
					id: "openai/gpt-4o",
					name: "GPT-4o",
					endpoints: [{ context_length: 128000 }],
				},
			}),
		});

		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const enricher = new ModelEnricher();
		enricher.initializePersistence(mockGlobalState as unknown as import("vscode").Memento);
		await enricher.enrichModel("openai:gpt-4o-2024-11-20", "test-api-key");

		expect(storage.size).toBe(1);

		await enricher.clearCache();

		expect(storage.size).toBe(0);
	});
});

describe("Enrichment-based capability refinement", () => {
	function createProvider() {
		const context = {
			workspaceState: {
				get: vi.fn(),
				update: vi.fn(),
			},
			globalState: {
				get: vi.fn(),
				update: vi.fn(),
			},
		} as unknown as ExtensionContext;

		return new VercelAIChatModelProvider(context);
	}

	function setEnriched(
		provider: VercelAIChatModelProvider,
		modelId: string,
		overrides: Partial<EnrichedModelData>,
	) {
		const enriched: EnrichedModelData = {
			context_length: null,
			max_completion_tokens: null,
			supported_parameters: [],
			supports_implicit_caching: false,
			input_modalities: [],
			...overrides,
		};
		(
			provider as unknown as {
				enrichedModels: Map<string, EnrichedModelData>;
			}
		).enrichedModels.set(modelId, enriched);
	}

	it("sets imageInput when input_modalities includes image", () => {
		const provider = createProvider();
		setEnriched(provider, "openai/gpt-4o", {
			input_modalities: ["text", "image"],
		});

		const models = [
			{
				id: "openai/gpt-4o",
				maxInputTokens: 8000,
				capabilities: { imageInput: false },
			} as LanguageModelChatInformation,
		];

		const refined = (
			provider as unknown as {
				applyEnrichmentToModels: (
					models: LanguageModelChatInformation[],
				) => LanguageModelChatInformation[];
			}
		).applyEnrichmentToModels(models);

		expect(refined[0].capabilities?.imageInput).toBe(true);
	});

	it("does not modify capabilities when input_modalities is missing", () => {
		const provider = createProvider();
		setEnriched(provider, "openai/gpt-4o", {
			input_modalities: [],
		});

		const models = [
			{
				id: "openai/gpt-4o",
				maxInputTokens: 8000,
				capabilities: { imageInput: false },
			} as LanguageModelChatInformation,
		];

		const refined = (
			provider as unknown as {
				applyEnrichmentToModels: (
					models: LanguageModelChatInformation[],
				) => LanguageModelChatInformation[];
			}
		).applyEnrichmentToModels(models);

		expect(refined[0].capabilities?.imageInput).toBe(false);
	});

	it("overrides maxInputTokens when context_length differs", () => {
		const provider = createProvider();
		setEnriched(provider, "openai/gpt-4o", {
			context_length: 128000,
		});

		const models = [
			{
				id: "openai/gpt-4o",
				maxInputTokens: 8000,
			} as LanguageModelChatInformation,
		];

		const refined = (
			provider as unknown as {
				applyEnrichmentToModels: (
					models: LanguageModelChatInformation[],
				) => LanguageModelChatInformation[];
			}
		).applyEnrichmentToModels(models);

		expect(refined[0].maxInputTokens).toBe(128000);
	});

	it("skips refinement when enrichment is disabled", async () => {
		hoisted.mockGetConfiguration.mockReturnValue({
			get: vi.fn((key: string, defaultValue: unknown) => {
				if (key === "endpoint") return "https://example.test";
				if (key === "logging.level") return "off";
				if (key === "logging.outputChannel") return false;
				if (key === "models.enrichmentEnabled") return false;
				return defaultValue;
			}),
		});

		hoisted.mockGetSession.mockResolvedValue({ accessToken: "test-token" });

		const provider = createProvider();
		setEnriched(provider, "openai/gpt-4o", {
			context_length: 128000,
			input_modalities: ["image"],
		});

		const models = [
			{
				id: "openai/gpt-4o",
				maxInputTokens: 8000,
				capabilities: { imageInput: false },
			} as LanguageModelChatInformation,
		];

		(
			provider as unknown as {
				modelsClient: {
					getModels: (apiKey: string) => Promise<LanguageModelChatInformation[]>;
				};
			}
		).modelsClient.getModels = vi.fn().mockResolvedValue(models);

		const result = await provider.provideLanguageModelChatInformation(
			{ silent: true },
			{} as import("vscode").CancellationToken,
		);

		expect(result[0].maxInputTokens).toBe(8000);
		expect(result[0].capabilities?.imageInput).toBe(false);
	});
});
