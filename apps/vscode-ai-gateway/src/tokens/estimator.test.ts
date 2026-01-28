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
import { ESTIMATION_MODES, type EstimationMode, TokenEstimator } from "./estimator";

describe("TokenEstimator", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default configuration - balanced mode
		hoisted.mockGetConfiguration.mockReturnValue({
			get: vi.fn((key: string, defaultValue: unknown) => defaultValue),
		});
	});

	describe("ESTIMATION_MODES", () => {
		it("should define conservative mode with lowest chars per token", () => {
			expect(ESTIMATION_MODES.conservative).toBe(3);
		});

		it("should define balanced mode with medium chars per token", () => {
			expect(ESTIMATION_MODES.balanced).toBe(4);
		});

		it("should define aggressive mode with highest chars per token", () => {
			expect(ESTIMATION_MODES.aggressive).toBe(5);
		});

		it("should have conservative < balanced < aggressive", () => {
			expect(ESTIMATION_MODES.conservative).toBeLessThan(ESTIMATION_MODES.balanced);
			expect(ESTIMATION_MODES.balanced).toBeLessThan(ESTIMATION_MODES.aggressive);
		});
	});

	describe("constructor", () => {
		it("should load configuration on creation", () => {
			new TokenEstimator();
			expect(hoisted.mockGetConfiguration).toHaveBeenCalledWith("vercelAiGateway");
		});

		it("should register configuration change listener", () => {
			new TokenEstimator();
			expect(hoisted.mockOnDidChangeConfiguration).toHaveBeenCalled();
		});
	});

	describe("estimateTokens", () => {
		it("should estimate tokens using balanced mode by default", () => {
			const estimator = new TokenEstimator();
			// "Hello World" = 11 chars, balanced = 4 chars/token -> 2.75 -> ceil = 3
			const result = estimator.estimateTokens("Hello World");
			expect(result).toBe(3);
		});

		it("should estimate tokens using conservative mode", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: unknown) => {
					if (key === "tokens.estimationMode") return "conservative";
					return defaultValue;
				}),
			});

			const estimator = new TokenEstimator();
			// "Hello World" = 11 chars, conservative = 3 chars/token -> 3.67 -> ceil = 4
			const result = estimator.estimateTokens("Hello World");
			expect(result).toBe(4);
		});

		it("should estimate tokens using aggressive mode", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: unknown) => {
					if (key === "tokens.estimationMode") return "aggressive";
					return defaultValue;
				}),
			});

			const estimator = new TokenEstimator();
			// "Hello World" = 11 chars, aggressive = 5 chars/token -> 2.2 -> ceil = 3
			const result = estimator.estimateTokens("Hello World");
			expect(result).toBe(3);
		});

		it("should use custom charsPerToken override", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: unknown) => {
					if (key === "tokens.charsPerToken") return 2;
					return defaultValue;
				}),
			});

			const estimator = new TokenEstimator();
			// "Hello World" = 11 chars, custom = 2 chars/token -> 5.5 -> ceil = 6
			const result = estimator.estimateTokens("Hello World");
			expect(result).toBe(6);
		});

		it("should handle empty string", () => {
			const estimator = new TokenEstimator();
			const result = estimator.estimateTokens("");
			expect(result).toBe(0);
		});

		it("should handle very long text", () => {
			const estimator = new TokenEstimator();
			const longText = "a".repeat(10000);
			// 10000 chars, balanced = 4 chars/token -> 2500
			const result = estimator.estimateTokens(longText);
			expect(result).toBe(2500);
		});

		it("should always round up (conservative estimate)", () => {
			const estimator = new TokenEstimator();
			// "Hi" = 2 chars, balanced = 4 chars/token -> 0.5 -> ceil = 1
			const result = estimator.estimateTokens("Hi");
			expect(result).toBe(1);
		});
	});

	describe("getCharsPerToken", () => {
		it("should return balanced mode value by default", () => {
			const estimator = new TokenEstimator();
			expect(estimator.getCharsPerToken()).toBe(4);
		});

		it("should return conservative mode value", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: unknown) => {
					if (key === "tokens.estimationMode") return "conservative";
					return defaultValue;
				}),
			});

			const estimator = new TokenEstimator();
			expect(estimator.getCharsPerToken()).toBe(3);
		});

		it("should return aggressive mode value", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: unknown) => {
					if (key === "tokens.estimationMode") return "aggressive";
					return defaultValue;
				}),
			});

			const estimator = new TokenEstimator();
			expect(estimator.getCharsPerToken()).toBe(5);
		});

		it("should return custom override value", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: unknown) => {
					if (key === "tokens.charsPerToken") return 3.5;
					return defaultValue;
				}),
			});

			const estimator = new TokenEstimator();
			expect(estimator.getCharsPerToken()).toBe(3.5);
		});
	});

	describe("getMode", () => {
		it("should return balanced by default", () => {
			const estimator = new TokenEstimator();
			expect(estimator.getMode()).toBe("balanced");
		});

		it("should return configured mode", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: unknown) => {
					if (key === "tokens.estimationMode") return "conservative";
					return defaultValue;
				}),
			});

			const estimator = new TokenEstimator();
			expect(estimator.getMode()).toBe("conservative");
		});
	});

	describe("configuration change handling", () => {
		it("should update estimation when configuration changes", () => {
			let configChangeCallback:
				| ((e: { affectsConfiguration: (s: string) => boolean }) => void)
				| undefined;

			(hoisted.mockOnDidChangeConfiguration.mockImplementation as (fn: unknown) => void)(
				(callback: (e: { affectsConfiguration: (s: string) => boolean }) => void) => {
					configChangeCallback = callback;
					return { dispose: vi.fn() };
				},
			);

			// Start with balanced mode
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: unknown) => defaultValue),
			});

			const estimator = new TokenEstimator();
			// "Hello World" = 11 chars, balanced = 4 chars/token -> ceil(2.75) = 3
			expect(estimator.estimateTokens("Hello World")).toBe(3);

			// Change to conservative mode
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: unknown) => {
					if (key === "tokens.estimationMode") return "conservative";
					return defaultValue;
				}),
			});

			// Trigger configuration change
			configChangeCallback?.({
				affectsConfiguration: (s: string) => s === "vercelAiGateway",
			});

			// "Hello World" = 11 chars, conservative = 3 chars/token -> ceil(3.67) = 4
			expect(estimator.estimateTokens("Hello World")).toBe(4);
		});
	});

	describe("estimateContextUsage", () => {
		it("should calculate percentage of context used", () => {
			const estimator = new TokenEstimator();
			// 1000 tokens used out of 4000 max = 25%
			const result = estimator.estimateContextUsage(1000, 4000);
			expect(result).toBe(25);
		});

		it("should handle zero max tokens", () => {
			const estimator = new TokenEstimator();
			const result = estimator.estimateContextUsage(1000, 0);
			expect(result).toBe(100);
		});

		it("should cap at 100%", () => {
			const estimator = new TokenEstimator();
			const result = estimator.estimateContextUsage(5000, 4000);
			expect(result).toBe(100);
		});

		it("should round to 2 decimal places", () => {
			const estimator = new TokenEstimator();
			// 1000 tokens used out of 3000 max = 33.333...%
			const result = estimator.estimateContextUsage(1000, 3000);
			expect(result).toBeCloseTo(33.33, 2);
		});
	});
});
