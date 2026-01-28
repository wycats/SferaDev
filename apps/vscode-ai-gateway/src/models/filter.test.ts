import { beforeEach, describe, expect, it, vi } from "vitest";

// Create hoisted mock functions
const hoisted = vi.hoisted(() => {
	const mockEventEmitterFire = vi.fn();
	const mockEventEmitterDispose = vi.fn();
	const mockEventEmitterEvent = vi.fn();
	const listeners: Array<() => void> = [];

	class MockEventEmitter {
		event = (listener: () => void) => {
			listeners.push(listener);
			mockEventEmitterEvent(listener);
			return { dispose: vi.fn() };
		};
		fire = () => {
			mockEventEmitterFire();
			for (const listener of listeners) {
				listener();
			}
		};
		dispose = mockEventEmitterDispose;
	}

	const mockGetConfiguration = vi.fn();
	const mockOnDidChangeConfiguration = vi.fn(
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		(_callback?: unknown) => ({ dispose: vi.fn() }),
	);

	return {
		mockEventEmitterFire,
		mockEventEmitterDispose,
		mockEventEmitterEvent,
		MockEventEmitter,
		mockGetConfiguration,
		mockOnDidChangeConfiguration,
	};
});

// Mock vscode module
vi.mock("vscode", () => ({
	EventEmitter: hoisted.MockEventEmitter,
	workspace: {
		getConfiguration: hoisted.mockGetConfiguration,
		onDidChangeConfiguration: hoisted.mockOnDidChangeConfiguration,
	},
}));

// Import after mocking
import { ModelFilter, type ModelFilterConfig, matchesPattern } from "./filter";

describe("ModelFilter", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default configuration - no filters
		hoisted.mockGetConfiguration.mockReturnValue({
			get: vi.fn((key: string, defaultValue: unknown) => defaultValue),
		});
	});

	describe("matchesPattern", () => {
		it("should match exact model IDs", () => {
			expect(matchesPattern("openai/gpt-4", "openai/gpt-4")).toBe(true);
			expect(matchesPattern("openai/gpt-4", "openai/gpt-3.5")).toBe(false);
		});

		it("should match wildcard at end", () => {
			expect(matchesPattern("openai/gpt-4", "openai/*")).toBe(true);
			expect(matchesPattern("openai/gpt-3.5", "openai/*")).toBe(true);
			expect(matchesPattern("anthropic/claude", "openai/*")).toBe(false);
		});

		it("should match wildcard at start", () => {
			expect(matchesPattern("openai/gpt-4", "*/gpt-4")).toBe(true);
			expect(matchesPattern("custom/gpt-4", "*/gpt-4")).toBe(true);
			expect(matchesPattern("openai/gpt-3.5", "*/gpt-4")).toBe(false);
		});

		it("should match wildcard in middle", () => {
			expect(matchesPattern("openai/gpt-4-turbo", "openai/gpt-*-turbo")).toBe(true);
			expect(matchesPattern("openai/gpt-3.5-turbo", "openai/gpt-*-turbo")).toBe(true);
			expect(matchesPattern("openai/gpt-4", "openai/gpt-*-turbo")).toBe(false);
		});

		it("should match multiple wildcards", () => {
			expect(matchesPattern("openai/gpt-4-turbo", "*/*-turbo")).toBe(true);
			expect(matchesPattern("anthropic/claude-turbo", "*/*-turbo")).toBe(true);
			expect(matchesPattern("openai/gpt-4", "*/*-turbo")).toBe(false);
		});

		it("should handle empty pattern", () => {
			expect(matchesPattern("openai/gpt-4", "")).toBe(false);
		});

		it("should handle wildcard-only pattern", () => {
			expect(matchesPattern("openai/gpt-4", "*")).toBe(true);
			expect(matchesPattern("anything", "*")).toBe(true);
		});
	});

	describe("constructor", () => {
		it("should load configuration on creation", () => {
			new ModelFilter();
			expect(hoisted.mockGetConfiguration).toHaveBeenCalledWith("vercelAiGateway");
		});

		it("should register configuration change listener", () => {
			new ModelFilter();
			expect(hoisted.mockOnDidChangeConfiguration).toHaveBeenCalled();
		});
	});

	describe("filterModels", () => {
		const mockModels = [
			{ id: "openai/gpt-4", name: "GPT-4" },
			{ id: "openai/gpt-3.5", name: "GPT-3.5" },
			{ id: "anthropic/claude-sonnet-4-20250514", name: "Claude Sonnet" },
			{ id: "anthropic/claude-opus-4-20250514", name: "Claude Opus" },
			{ id: "google/gemini-pro", name: "Gemini Pro" },
		];

		it("should return all models when no filters are set", () => {
			const filter = new ModelFilter();
			const result = filter.filterModels(mockModels);
			expect(result).toHaveLength(5);
		});

		it("should filter by allowlist with exact match", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: unknown) => {
					if (key === "models.allowlist") {
						return ["openai/gpt-4", "anthropic/claude-sonnet-4-20250514"];
					}
					return defaultValue;
				}),
			});

			const filter = new ModelFilter();
			const result = filter.filterModels(mockModels);

			expect(result).toHaveLength(2);
			expect(result.map((m) => m.id)).toEqual([
				"openai/gpt-4",
				"anthropic/claude-sonnet-4-20250514",
			]);
		});

		it("should filter by allowlist with wildcard", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: unknown) => {
					if (key === "models.allowlist") return ["openai/*"];
					return defaultValue;
				}),
			});

			const filter = new ModelFilter();
			const result = filter.filterModels(mockModels);

			expect(result).toHaveLength(2);
			expect(result.map((m) => m.id)).toEqual(["openai/gpt-4", "openai/gpt-3.5"]);
		});

		it("should filter by denylist with exact match", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: unknown) => {
					if (key === "models.denylist") return ["openai/gpt-3.5"];
					return defaultValue;
				}),
			});

			const filter = new ModelFilter();
			const result = filter.filterModels(mockModels);

			expect(result).toHaveLength(4);
			expect(result.map((m) => m.id)).not.toContain("openai/gpt-3.5");
		});

		it("should filter by denylist with wildcard", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: unknown) => {
					if (key === "models.denylist") return ["anthropic/*"];
					return defaultValue;
				}),
			});

			const filter = new ModelFilter();
			const result = filter.filterModels(mockModels);

			expect(result).toHaveLength(3);
			expect(result.map((m) => m.id)).toEqual([
				"openai/gpt-4",
				"openai/gpt-3.5",
				"google/gemini-pro",
			]);
		});

		it("should apply denylist after allowlist", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: unknown) => {
					if (key === "models.allowlist") return ["openai/*"];
					if (key === "models.denylist") return ["openai/gpt-3.5"];
					return defaultValue;
				}),
			});

			const filter = new ModelFilter();
			const result = filter.filterModels(mockModels);

			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("openai/gpt-4");
		});
	});

	describe("getFallbacks", () => {
		it("should return empty array when no fallbacks configured", () => {
			const filter = new ModelFilter();
			const result = filter.getFallbacks("openai/gpt-4");
			expect(result).toEqual([]);
		});

		it("should return configured fallbacks for a model", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: unknown) => {
					if (key === "models.fallbacks") {
						return {
							"openai/gpt-4": ["openai/gpt-3.5", "anthropic/claude-sonnet-4-20250514"],
						};
					}
					return defaultValue;
				}),
			});

			const filter = new ModelFilter();
			const result = filter.getFallbacks("openai/gpt-4");

			expect(result).toEqual(["openai/gpt-3.5", "anthropic/claude-sonnet-4-20250514"]);
		});

		it("should return empty array for model without fallbacks", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: unknown) => {
					if (key === "models.fallbacks") {
						return {
							"openai/gpt-4": ["openai/gpt-3.5"],
						};
					}
					return defaultValue;
				}),
			});

			const filter = new ModelFilter();
			const result = filter.getFallbacks("anthropic/claude");

			expect(result).toEqual([]);
		});
	});

	describe("getDefaultModel", () => {
		it("should return empty string when no default configured", () => {
			const filter = new ModelFilter();
			const result = filter.getDefaultModel();
			expect(result).toBe("");
		});

		it("should return configured default model", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: unknown) => {
					if (key === "models.default") return "openai/gpt-4";
					return defaultValue;
				}),
			});

			const filter = new ModelFilter();
			const result = filter.getDefaultModel();

			expect(result).toBe("openai/gpt-4");
		});
	});

	describe("configuration change handling", () => {
		it("should update filters when configuration changes", () => {
			let configChangeCallback:
				| ((e: { affectsConfiguration: (s: string) => boolean }) => void)
				| undefined;

			(hoisted.mockOnDidChangeConfiguration.mockImplementation as (fn: unknown) => void)(
				(callback: (e: { affectsConfiguration: (s: string) => boolean }) => void) => {
					configChangeCallback = callback;
					return { dispose: vi.fn() };
				},
			);

			// Start with no filters
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: unknown) => defaultValue),
			});

			const filter = new ModelFilter();
			const mockModels = [
				{ id: "openai/gpt-4", name: "GPT-4" },
				{ id: "anthropic/claude", name: "Claude" },
			];

			// All models should be returned
			expect(filter.filterModels(mockModels)).toHaveLength(2);

			// Change to allowlist
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: unknown) => {
					if (key === "models.allowlist") return ["openai/*"];
					return defaultValue;
				}),
			});

			// Trigger configuration change
			configChangeCallback?.({
				affectsConfiguration: (s: string) => s === "vercelAiGateway",
			});

			// Now only OpenAI models should be returned
			expect(filter.filterModels(mockModels)).toHaveLength(1);
			expect(filter.filterModels(mockModels)[0].id).toBe("openai/gpt-4");
		});
	});
});
