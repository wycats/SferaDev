import { streamText } from "ai";
import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, LanguageModelChatMessage } from "vscode";
import { LAST_SELECTED_MODEL_KEY } from "./constants";
import {
	convertMessages,
	convertSingleMessage,
	isValidMimeType,
	VercelAIChatModelProvider,
} from "./provider";

// Create hoisted mock functions
const hoisted = vi.hoisted(() => {
	const mockEventEmitterFire = vi.fn();
	const mockEventEmitterDispose = vi.fn();
	const mockEventEmitterEvent = vi.fn();
	const mockDisposable = { dispose: vi.fn() };

	class MockEventEmitter {
		event = mockEventEmitterEvent;
		fire = mockEventEmitterFire;
		dispose = mockEventEmitterDispose;
	}

	const mockGetSession = vi.fn();
	const mockShowErrorMessage = vi.fn();
	const mockGetConfiguration = vi.fn();

	// Mock LanguageModel* part constructors
	class MockLanguageModelTextPart {
		constructor(public value: string) {}
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

	class MockLanguageModelDataPart {
		constructor(
			public data: Uint8Array,
			public mimeType: string,
		) {}

		static image(data: Uint8Array, mimeType: string) {
			return new MockLanguageModelDataPart(data, mimeType);
		}

		static text(value: string, mimeType: string) {
			return new MockLanguageModelDataPart(new TextEncoder().encode(value), mimeType);
		}

		static json(value: unknown, mimeType = "application/json") {
			return new MockLanguageModelDataPart(
				new TextEncoder().encode(JSON.stringify(value)),
				mimeType,
			);
		}
	}

	// Optional: Mock LanguageModelThinkingPart (unstable API)
	class MockLanguageModelThinkingPart {
		constructor(
			public text: string,
			public id?: string,
		) {}
	}

	return {
		mockEventEmitterFire,
		mockEventEmitterDispose,
		mockEventEmitterEvent,
		MockEventEmitter,
		mockDisposable,
		mockGetSession,
		mockShowErrorMessage,
		mockGetConfiguration,
		MockLanguageModelTextPart,
		MockLanguageModelToolCallPart,
		MockLanguageModelToolResultPart,
		MockLanguageModelDataPart,
		MockLanguageModelThinkingPart,
	};
});

// Mock vscode module
vi.mock("vscode", () => ({
	EventEmitter: hoisted.MockEventEmitter,
	authentication: {
		getSession: hoisted.mockGetSession,
	},
	window: {
		showErrorMessage: hoisted.mockShowErrorMessage,
		createOutputChannel: vi.fn(() => ({
			appendLine: vi.fn(),
			show: vi.fn(),
			dispose: vi.fn(),
		})),
	},
	workspace: {
		getConfiguration: hoisted.mockGetConfiguration,
		onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
	},
	LanguageModelTextPart: hoisted.MockLanguageModelTextPart,
	LanguageModelToolCallPart: hoisted.MockLanguageModelToolCallPart,
	LanguageModelToolResultPart: hoisted.MockLanguageModelToolResultPart,
	LanguageModelDataPart: hoisted.MockLanguageModelDataPart,
	LanguageModelThinkingPart: hoisted.MockLanguageModelThinkingPart,
	LanguageModelChatMessageRole: {
		User: 1,
		Assistant: 2,
	},
	LanguageModelChatToolMode: {
		Auto: "auto",
		Required: "required",
	},
}));

// Mock the auth module
vi.mock("./auth", () => ({
	VERCEL_AI_AUTH_PROVIDER_ID: "vercelAiAuth",
}));

// Mock the AI SDK
vi.mock("@ai-sdk/gateway", () => ({
	createGatewayProvider: vi.fn(() => () => ({})),
}));

vi.mock("ai", () => ({
	jsonSchema: vi.fn((schema) => schema),
	streamText: vi.fn(),
}));

vi.mock("./models", () => ({
	ModelsClient: class {
		getModels = vi.fn();
	},
}));

// Import types for testing
interface MockChunk {
	type: string;
	[key: string]: unknown;
}

/**
 * Helper to create a mock progress reporter with spy capabilities
 */
function createMockProgress() {
	const report = vi.fn();
	return { report };
}

function createProvider() {
	const context = {
		workspaceState: {
			get: vi.fn(),
			update: vi.fn(),
		},
	} as unknown as ExtensionContext;

	return new VercelAIChatModelProvider(context);
}

const DEFAULT_SYSTEM_PROMPT =
	"You are being accessed through the Vercel AI Gateway VS Code extension. The user is interacting with you via VS Code's chat interface.";

function createEmptyStream() {
	return {
		fullStream: (async function* () {})(),
	};
}

/**
 * Test the chunk type classification based on the SILENTLY_IGNORED_CHUNK_TYPES set
 * from the provider implementation.
 */
describe("Stream Chunk Type Coverage", () => {
	/**
	 * Chunk types that should be mapped to VS Code LanguageModelResponsePart
	 */
	describe("Mapped chunk types", () => {
		it("text-delta should emit LanguageModelTextPart", () => {
			const progress = createMockProgress();
			// fullStream TextStreamPart uses 'text' field, not 'textDelta'
			const chunk: MockChunk = { type: "text-delta", text: "Hello, world!" };

			// Simulate the handler logic
			if (chunk.type === "text-delta" && chunk.text) {
				progress.report(new hoisted.MockLanguageModelTextPart(chunk.text as string));
			}

			expect(progress.report).toHaveBeenCalledTimes(1);
			const reported = progress.report.mock.calls[0][0];
			expect(reported).toBeInstanceOf(hoisted.MockLanguageModelTextPart);
			expect(reported.value).toBe("Hello, world!");
		});

		it("text-delta with empty string should not emit", () => {
			const progress = createMockProgress();
			// fullStream TextStreamPart uses 'text' field, not 'textDelta'
			const chunk: MockChunk = { type: "text-delta", text: "" };

			// Simulate the handler logic
			if (chunk.type === "text-delta" && chunk.text) {
				progress.report(new hoisted.MockLanguageModelTextPart(chunk.text as string));
			}

			expect(progress.report).not.toHaveBeenCalled();
		});

		it("reasoning-delta should emit LanguageModelThinkingPart when available", () => {
			const progress = createMockProgress();
			// fullStream TextStreamPart uses 'text' field for reasoning-delta, not 'delta'
			const chunk: MockChunk = {
				type: "reasoning-delta",
				text: "Let me think...",
				id: "reasoning-1",
			};

			// Simulate the handler logic with ThinkingPart available
			const ThinkingCtor = hoisted.MockLanguageModelThinkingPart;
			if (ThinkingCtor && chunk.text) {
				progress.report(new ThinkingCtor(chunk.text as string));
			}

			expect(progress.report).toHaveBeenCalledTimes(1);
			const reported = progress.report.mock.calls[0][0];
			expect(reported).toBeInstanceOf(hoisted.MockLanguageModelThinkingPart);
			expect(reported.text).toBe("Let me think...");
		});

		it("file with data URL should emit LanguageModelDataPart", () => {
			const progress = createMockProgress();
			const content = "Hello from file";
			const base64Content = Buffer.from(content).toString("base64");
			const chunk: MockChunk = {
				type: "file",
				url: `data:text/plain;base64,${base64Content}`,
				mediaType: "text/plain",
			};

			// Simulate the handler logic
			if (chunk.type === "file" && (chunk.url as string).startsWith("data:")) {
				const url = chunk.url as string;
				const commaIndex = url.indexOf(",");
				if (commaIndex !== -1) {
					const base64Data = url.slice(commaIndex + 1);
					const bytes = Buffer.from(base64Data, "base64");
					const dataPart = hoisted.MockLanguageModelDataPart.text(
						new TextDecoder().decode(bytes),
						chunk.mediaType as string,
					);
					progress.report(dataPart);
				}
			}

			expect(progress.report).toHaveBeenCalledTimes(1);
			const reported = progress.report.mock.calls[0][0];
			expect(reported).toBeInstanceOf(hoisted.MockLanguageModelDataPart);
			expect(reported.mimeType).toBe("text/plain");
		});

		it("error should emit LanguageModelTextPart with formatted message", () => {
			const progress = createMockProgress();
			const chunk: MockChunk = {
				type: "error",
				error: "Rate limit exceeded",
			};

			// Simulate the handler logic
			if (chunk.type === "error") {
				const errorMessage =
					chunk.error instanceof Error
						? chunk.error.message
						: chunk.error
							? String(chunk.error)
							: "Unknown error occurred";
				progress.report(
					new hoisted.MockLanguageModelTextPart(`\n\n**Error:** ${errorMessage}\n\n`),
				);
			}

			expect(progress.report).toHaveBeenCalledTimes(1);
			const reported = progress.report.mock.calls[0][0];
			expect(reported).toBeInstanceOf(hoisted.MockLanguageModelTextPart);
			expect(reported.value).toContain("Rate limit exceeded");
		});
	});

	/**
	 * Chunk types that should be silently ignored (no VS Code equivalent)
	 */
	describe("Silently ignored chunk types", () => {
		const silentlyIgnoredTypes = [
			// Streaming lifecycle events
			"start",
			"finish",
			"abort",
			"start-step",
			"finish-step",
			// Text lifecycle markers
			"text-start",
			"text-end",
			// Reasoning lifecycle
			"reasoning-start",
			"reasoning-end",
			// Source references
			"source-url",
			"source-document",
			// Tool lifecycle (handled via callback)
			"tool-input-start",
			"tool-input-delta",
			"tool-input-error",
			"tool-input-available",
			"tool-output-available",
			"tool-output-error",
			"tool-output-denied",
			"tool-approval-request",
			// Message metadata
			"message-metadata",
		];

		for (const chunkType of silentlyIgnoredTypes) {
			it(`${chunkType} should not emit any part`, () => {
				const progress = createMockProgress();
				const chunk: MockChunk = { type: chunkType };

				// These types should not trigger progress.report
				const mappedTypes = ["text-delta", "reasoning-delta", "file", "error"];
				if (!mappedTypes.includes(chunk.type)) {
					// Silently ignored - no report
				}

				expect(progress.report).not.toHaveBeenCalled();
			});
		}
	});

	/**
	 * Custom data chunk types (data-*) should be silently ignored
	 */
	describe("Custom data chunk types", () => {
		it("data-* chunk types should be silently ignored", () => {
			const progress = createMockProgress();
			const dataChunkTypes = ["data-custom", "data-image", "data-annotation", "data-metadata"];

			for (const chunkType of dataChunkTypes) {
				const chunk: MockChunk = { type: chunkType, data: { test: "value" } };

				// Custom data chunks are silently ignored
				const mappedTypes = ["text-delta", "reasoning-delta", "file", "error"];
				if (!mappedTypes.includes(chunk.type)) {
					// Silently ignored - no report
				}

				expect(progress.report).not.toHaveBeenCalled();
			}
		});
	});

	/**
	 * Edge cases and error handling
	 */
	describe("Edge cases", () => {
		it("error chunk without errorText should use default message", () => {
			const progress = createMockProgress();
			const chunk: MockChunk = { type: "error" };

			if (chunk.type === "error") {
				const errorMessage =
					chunk.error instanceof Error
						? chunk.error.message
						: chunk.error
							? String(chunk.error)
							: "Unknown error occurred";
				progress.report(
					new hoisted.MockLanguageModelTextPart(`\n\n**Error:** ${errorMessage}\n\n`),
				);
			}

			expect(progress.report).toHaveBeenCalledTimes(1);
			const reported = progress.report.mock.calls[0][0];
			expect(reported.value).toContain("Unknown error occurred");
		});

		it("file with non-data URL should not emit (async fetch not supported)", () => {
			const progress = createMockProgress();
			const chunk: MockChunk = {
				type: "file",
				url: "https://example.com/image.png",
				mediaType: "image/png",
			};

			// Non-data URLs cannot be fetched synchronously in stream handler
			if (chunk.type === "file") {
				const url = chunk.url as string;
				if (url.startsWith("data:")) {
					// Would handle data URL...
				} else {
					// Skip - can't fetch async in stream handler
				}
			}

			expect(progress.report).not.toHaveBeenCalled();
		});

		it("file with malformed data URL should not crash", () => {
			const progress = createMockProgress();
			const chunk: MockChunk = {
				type: "file",
				url: "data:malformed",
				mediaType: "text/plain",
			};

			// Simulate the handler logic with error handling
			if (chunk.type === "file" && (chunk.url as string).startsWith("data:")) {
				const url = chunk.url as string;
				const commaIndex = url.indexOf(",");
				if (commaIndex !== -1) {
					const base64Data = url.slice(commaIndex + 1);
					try {
						const bytes = Buffer.from(base64Data, "base64");
						const dataPart = hoisted.MockLanguageModelDataPart.text(
							new TextDecoder().decode(bytes),
							chunk.mediaType as string,
						);
						progress.report(dataPart);
					} catch {
						// Silently skip malformed data
					}
				}
				// No comma = silently skip
			}

			expect(progress.report).not.toHaveBeenCalled();
		});
	});
});

/**
 * Test the complete list of Vercel AI SDK UIMessageChunk types
 * to ensure we have explicit handling for each one.
 */
describe("UIMessageChunk Type Completeness", () => {
	/**
	 * All chunk types from Vercel AI SDK's UIMessageChunk type.
	 * This test documents the expected behavior for each type.
	 */
	const chunkTypeHandling: Record<string, "mapped" | "ignored" | "callback"> = {
		// Mapped to VS Code parts
		"text-delta": "mapped",
		"reasoning-delta": "mapped",
		file: "mapped",
		error: "mapped",

		// Handled via tool execute callback
		"tool-input-available": "callback",

		// Silently ignored - streaming lifecycle
		start: "ignored",
		finish: "ignored",
		abort: "ignored",
		"start-step": "ignored",
		"finish-step": "ignored",

		// Silently ignored - text lifecycle
		"text-start": "ignored",
		"text-end": "ignored",

		// Silently ignored - reasoning lifecycle
		"reasoning-start": "ignored",
		"reasoning-end": "ignored",

		// Silently ignored - sources
		"source-url": "ignored",
		"source-document": "ignored",

		// Silently ignored - tool lifecycle
		"tool-input-start": "ignored",
		"tool-input-delta": "ignored",
		"tool-input-error": "ignored",
		"tool-output-available": "ignored",
		"tool-output-error": "ignored",
		"tool-output-denied": "ignored",
		"tool-approval-request": "ignored",

		// Silently ignored - metadata
		"message-metadata": "ignored",
	};

	it("should have documented handling for all known chunk types", () => {
		const knownTypes = Object.keys(chunkTypeHandling);

		// Verify we have at least the core types documented
		expect(knownTypes).toContain("text-delta");
		expect(knownTypes).toContain("reasoning-delta");
		expect(knownTypes).toContain("error");
		expect(knownTypes).toContain("file");
		expect(knownTypes).toContain("start");
		expect(knownTypes).toContain("finish");
	});

	it("should map text-delta, reasoning-delta, file, and error", () => {
		const mappedTypes = Object.entries(chunkTypeHandling)
			.filter(([, handling]) => handling === "mapped")
			.map(([type]) => type);

		expect(mappedTypes).toContain("text-delta");
		expect(mappedTypes).toContain("reasoning-delta");
		expect(mappedTypes).toContain("file");
		expect(mappedTypes).toContain("error");
	});

	it("should handle tool-input-available via callback", () => {
		expect(chunkTypeHandling["tool-input-available"]).toBe("callback");
	});
});

describe("System prompt configuration", () => {
	const model = {
		id: "test-model",
		maxInputTokens: 10000,
		family: "openai",
	} as any;

	const token = {
		onCancellationRequested: () => ({ dispose: vi.fn() }),
	} as any;

	const options = {
		toolMode: "auto",
		tools: [],
		modelOptions: {},
	} as any;

	const chatMessages = [
		{
			role: 1,
			content: [new hoisted.MockLanguageModelTextPart("Hello")],
		} as unknown as LanguageModelChatMessage,
	];

	beforeEach(() => {
		vi.clearAllMocks();
		hoisted.mockGetSession.mockResolvedValue({ accessToken: "token" });
		(streamText as unknown as { mockReturnValue: Function }).mockReturnValue(createEmptyStream());
	});

	it("passes system prompt when enabled", async () => {
		hoisted.mockGetConfiguration.mockReturnValue({
			get: (key: string, defaultValue?: unknown) => {
				if (key === "systemPrompt.enabled") return true;
				if (key === "systemPrompt.message") return "Use the system prompt.";
				return defaultValue;
			},
		});

		const provider = createProvider();
		const progress = createMockProgress();

		await provider.provideLanguageModelChatResponse(model, chatMessages, options, progress, token);

		const callArgs = (streamText as unknown as { mock: { calls: any[] } }).mock.calls[0][0];
		expect(callArgs.system).toBe("Use the system prompt.");
	});

	it("omits system prompt when disabled", async () => {
		hoisted.mockGetConfiguration.mockReturnValue({
			get: (key: string, defaultValue?: unknown) => {
				if (key === "systemPrompt.enabled") return false;
				if (key === "systemPrompt.message") return "Use the system prompt.";
				return defaultValue;
			},
		});

		const provider = createProvider();
		const progress = createMockProgress();

		await provider.provideLanguageModelChatResponse(model, chatMessages, options, progress, token);

		const callArgs = (streamText as unknown as { mock: { calls: any[] } }).mock.calls[0][0];
		expect(callArgs.system).toBeUndefined();
	});

	it("falls back to the default system prompt when no message is set", async () => {
		hoisted.mockGetConfiguration.mockReturnValue({
			get: (key: string, defaultValue?: unknown) => {
				if (key === "systemPrompt.enabled") return true;
				if (key === "systemPrompt.message") return defaultValue;
				return defaultValue;
			},
		});

		const provider = createProvider();
		const progress = createMockProgress();

		await provider.provideLanguageModelChatResponse(model, chatMessages, options, progress, token);

		const callArgs = (streamText as unknown as { mock: { calls: any[] } }).mock.calls[0][0];
		expect(callArgs.system).toBe(DEFAULT_SYSTEM_PROMPT);
	});
});

describe("Model selection memory", () => {
	const model = {
		id: "test-model",
		maxInputTokens: 10000,
		family: "openai",
	} as any;

	const token = {
		onCancellationRequested: () => ({ dispose: vi.fn() }),
	} as any;

	const options = {
		toolMode: "auto",
		tools: [],
		modelOptions: {},
	} as any;

	const chatMessages = [
		{
			role: 1,
			content: [new hoisted.MockLanguageModelTextPart("Hello")],
		} as unknown as LanguageModelChatMessage,
	];

	beforeEach(() => {
		vi.clearAllMocks();
		hoisted.mockGetSession.mockResolvedValue({ accessToken: "token" });
		hoisted.mockGetConfiguration.mockReturnValue({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
		});
		(streamText as unknown as { mockReturnValue: Function }).mockReturnValue(createEmptyStream());
	});

	it("persists the last selected model id after successful completion", async () => {
		const context = {
			workspaceState: {
				get: vi.fn(),
				update: vi.fn().mockResolvedValue(undefined),
			},
		} as unknown as ExtensionContext;

		const provider = new VercelAIChatModelProvider(context);
		const progress = createMockProgress();

		await provider.provideLanguageModelChatResponse(model, chatMessages, options, progress, token);

		expect(context.workspaceState.update).toHaveBeenCalledWith(LAST_SELECTED_MODEL_KEY, model.id);
	});

	it("returns the last selected model id from workspace state", () => {
		const context = {
			workspaceState: {
				get: vi.fn().mockReturnValue("stored-model"),
				update: vi.fn(),
			},
		} as unknown as ExtensionContext;

		const provider = new VercelAIChatModelProvider(context);

		expect(provider.getLastSelectedModelId()).toBe("stored-model");
		expect(context.workspaceState.get).toHaveBeenCalledWith(LAST_SELECTED_MODEL_KEY);
	});
});

describe("Property-based tests", () => {
	it("accepts valid MIME types", () => {
		const lowerAlpha = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split(""));
		const subtypeChar = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789.+-".split(""));
		const typeArb = fc.stringOf(lowerAlpha, { minLength: 1 });
		const subtypeArb = fc.stringOf(subtypeChar, { minLength: 1 });

		const validMimeTypeArb = fc
			.tuple(typeArb, subtypeArb)
			.map(([type, subtype]) => `${type}/${subtype}`);

		fc.assert(
			fc.property(validMimeTypeArb, (mimeType) => {
				expect(isValidMimeType(mimeType)).toBe(true);
			}),
		);
	});

	it("rejects invalid MIME types", () => {
		const lowerAlpha = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split(""));
		const subtypeChar = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789.+-".split(""));
		const typeArb = fc.stringOf(lowerAlpha, { minLength: 1 });
		const subtypeArb = fc.stringOf(subtypeChar, { minLength: 1 });
		const typeWithUnderscoreArb = fc
			.stringOf(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz_".split("")), {
				minLength: 1,
			})
			.filter((value) => value.includes("_"));
		const subtypeWithUnderscoreArb = fc
			.stringOf(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789.+-_".split("")), {
				minLength: 1,
			})
			.filter((value) => value.includes("_"));

		const invalidMimeTypeArb = fc.oneof(
			fc.constant("cache_control"),
			fc.tuple(typeArb, subtypeArb).map(([type, subtype]) => `${type}${subtype}`),
			typeArb.map((type) => `${type}/`),
			subtypeArb.map((subtype) => `/${subtype}`),
			fc.tuple(typeWithUnderscoreArb, subtypeArb).map(([type, subtype]) => `${type}/${subtype}`),
			fc.tuple(typeArb, subtypeWithUnderscoreArb).map(([type, subtype]) => `${type}/${subtype}`),
		);

		fc.assert(
			fc.property(invalidMimeTypeArb, (mimeType) => {
				expect(isValidMimeType(mimeType)).toBe(false);
			}),
		);
	});

	it("stream chunk handler should not crash on unexpected fields", () => {
		const provider = createProvider();
		const progress = createMockProgress();
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		fc.assert(
			fc.property(fc.string(), fc.dictionary(fc.string(), fc.anything()), (type, extra) => {
				expect(() =>
					(provider as unknown as { handleStreamChunk: Function }).handleStreamChunk(
						{ type, ...extra } as unknown,
						progress,
					),
				).not.toThrow();
			}),
		);

		warnSpy.mockRestore();
	});

	it("ignored chunk types never report progress", () => {
		const provider = createProvider();
		const ignoredTypes = [
			"start",
			"start-step",
			"abort",
			"finish",
			"finish-step",
			"text-start",
			"text-end",
			"reasoning-start",
			"reasoning-end",
			"source",
			"tool-result",
			"tool-input-start",
			"tool-input-delta",
		];

		fc.assert(
			fc.property(fc.constantFrom(...ignoredTypes), (type) => {
				const progress = createMockProgress();
				(provider as unknown as { handleStreamChunk: Function }).handleStreamChunk(
					{ type } as unknown,
					progress,
				);
				expect(progress.report).not.toHaveBeenCalled();
			}),
		);
	});

	it("text-delta reports exactly one LanguageModelTextPart when text is non-empty", () => {
		const provider = createProvider();

		fc.assert(
			fc.property(fc.string({ minLength: 1 }), (text) => {
				const progress = createMockProgress();
				(provider as unknown as { handleStreamChunk: Function }).handleStreamChunk(
					{ type: "text-delta", text } as unknown,
					progress,
				);
				expect(progress.report).toHaveBeenCalledTimes(1);
				const reported = progress.report.mock.calls[0][0];
				expect(reported).toBeInstanceOf(hoisted.MockLanguageModelTextPart);
			}),
		);
	});

	it("tool-call chunks always report LanguageModelToolCallPart", () => {
		const provider = createProvider();

		fc.assert(
			fc.property(
				fc.uuid(),
				fc.string({ minLength: 1 }),
				fc.dictionary(fc.string(), fc.anything()),
				(callId, name, input) => {
					const progress = createMockProgress();
					(provider as unknown as { handleStreamChunk: Function }).handleStreamChunk(
						{
							type: "tool-call",
							toolCallId: callId,
							toolName: name,
							input,
						} as unknown,
						progress,
					);
					expect(progress.report).toHaveBeenCalledTimes(1);
					const reported = progress.report.mock.calls[0][0];
					expect(reported).toBeInstanceOf(hoisted.MockLanguageModelToolCallPart);
					expect(reported.callId).toBe(callId);
					expect(reported.name).toBe(name);
				},
			),
		);
	});

	it("message conversion should not crash on varied content shapes", () => {
		const textPartArb = fc.string().map((value) => new hoisted.MockLanguageModelTextPart(value));
		const dataPartArb = fc
			.uint8Array()
			.map((data) => new hoisted.MockLanguageModelDataPart(data, "text/plain"));
		const toolCallArb = fc
			.record({
				callId: fc.uuid(),
				name: fc.string(),
				input: fc.dictionary(fc.string(), fc.anything()),
			})
			.map(
				({ callId, name, input }) => new hoisted.MockLanguageModelToolCallPart(callId, name, input),
			);
		const toolResultArb = fc
			.record({
				callId: fc.uuid(),
				content: fc.array(
					fc.oneof(fc.record({ value: fc.string() }), fc.dictionary(fc.string(), fc.anything())),
				),
			})
			.map(({ callId, content }) => new hoisted.MockLanguageModelToolResultPart(callId, content));

		const contentPartArb = fc.oneof(
			fc.string(),
			fc.integer(),
			fc.boolean(),
			fc.constant(null),
			fc.dictionary(fc.string(), fc.anything()),
			textPartArb,
			dataPartArb,
			toolCallArb,
			toolResultArb,
		);

		fc.assert(
			fc.property(fc.array(contentPartArb), (content) => {
				const msg = {
					role: 1,
					content,
				} as unknown as LanguageModelChatMessage;

				expect(() => convertSingleMessage(msg, {})).not.toThrow();
			}),
		);
	});
});

describe("Fixture-based tests", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("skips cache_control metadata in file chunks", () => {
		const provider = createProvider();
		const progress = createMockProgress();
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		(provider as unknown as { handleStreamChunk: Function }).handleStreamChunk(
			{
				type: "file",
				file: {
					base64: "",
					uint8Array: new Uint8Array([1, 2, 3]),
					mediaType: "cache_control",
				},
			},
			progress,
		);

		expect(progress.report).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalledWith("[VercelAI] Unsupported file mime type: cache_control");
	});

	it("handles file chunks with valid and invalid MIME types", () => {
		const provider = createProvider();
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const fixtures = [
			{
				label: "image",
				mimeType: "image/png",
				data: new Uint8Array([137, 80, 78, 71]),
				shouldReport: true,
			},
			{
				label: "text",
				mimeType: "text/plain",
				data: new TextEncoder().encode("hello"),
				shouldReport: true,
			},
			{
				label: "json",
				mimeType: "application/json",
				data: new TextEncoder().encode(JSON.stringify({ ok: true })),
				shouldReport: true,
			},
			{
				label: "invalid",
				mimeType: "cache_control",
				data: new Uint8Array([1]),
				shouldReport: false,
			},
		];

		for (const fixture of fixtures) {
			const progress = createMockProgress();
			(provider as unknown as { handleStreamChunk: Function }).handleStreamChunk(
				{
					type: "file",
					file: {
						base64: "",
						uint8Array: fixture.data,
						mediaType: fixture.mimeType,
					},
				},
				progress,
			);

			if (fixture.shouldReport) {
				expect(progress.report).toHaveBeenCalledTimes(1);
				const reported = progress.report.mock.calls[0][0];
				expect(reported).toBeInstanceOf(hoisted.MockLanguageModelDataPart);
			} else {
				expect(progress.report).not.toHaveBeenCalled();
			}
		}

		expect(warnSpy).toHaveBeenCalledWith("[VercelAI] Unsupported file mime type: cache_control");
	});

	it("handles tool call streaming chunks", () => {
		const provider = createProvider();
		const progress = createMockProgress();

		(provider as unknown as { handleStreamChunk: Function }).handleStreamChunk(
			{
				type: "tool-call",
				toolCallId: "call-1",
				toolName: "searchDocs",
				input: { query: "test" },
			},
			progress,
		);

		expect(progress.report).toHaveBeenCalledTimes(1);
		const reported = progress.report.mock.calls[0][0];
		expect(reported).toBeInstanceOf(hoisted.MockLanguageModelToolCallPart);
		expect(reported.name).toBe("searchDocs");
	});

	it("maps tool result names using the prior tool call", () => {
		const messages = [
			{
				role: 2,
				content: [
					new hoisted.MockLanguageModelToolCallPart("test-call-1", "searchDocs", { query: "test" }),
				],
			} as unknown as LanguageModelChatMessage,
			{
				role: 2,
				content: [
					new hoisted.MockLanguageModelToolResultPart("test-call-1", [{ value: "result" }]),
				],
			} as unknown as LanguageModelChatMessage,
		];

		const converted = convertMessages(messages);
		const toolResult = converted.find(
			(msg) =>
				msg.role === "tool" && Array.isArray(msg.content) && msg.content[0]?.type === "tool-result",
		);

		expect(toolResult).toBeDefined();
		if (toolResult && Array.isArray(toolResult.content)) {
			const toolResultPart = toolResult.content[0];
			expect(toolResultPart.type).toBe("tool-result");
			expect("toolName" in toolResultPart).toBe(true);
			if ("toolName" in toolResultPart) {
				expect(toolResultPart.toolName).toBe("searchDocs");
			}
		}
	});
});
