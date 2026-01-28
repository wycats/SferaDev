import { createHash } from "node:crypto";
import { createGatewayProvider } from "@ai-sdk/gateway";
import { jsonSchema, type ModelMessage, streamText, type TextStreamPart, type ToolSet } from "ai";
import * as vscode from "vscode";
import {
	authentication,
	type CancellationToken,
	type ExtensionContext,
	type LanguageModelChatInformation,
	type LanguageModelChatMessage,
	LanguageModelChatMessageRole,
	type LanguageModelChatProvider,
	type LanguageModelChatRequestMessage,
	LanguageModelChatToolMode,
	LanguageModelDataPart,
	type LanguageModelResponsePart,
	LanguageModelTextPart,
	LanguageModelToolCallPart,
	LanguageModelToolResultPart,
	type Progress,
	type ProvideLanguageModelChatResponseOptions,
	window,
} from "vscode";

/**
 * Type alias for the chunk types emitted by Vercel AI SDK's fullStream.
 * fullStream provides access to all events including tool-calls, which
 * toUIMessageStream() hides.
 */
type StreamChunk = TextStreamPart<ToolSet>;

import { VERCEL_AI_AUTH_PROVIDER_ID } from "./auth";
import { ConfigService } from "./config";
import {
	DEFAULT_SYSTEM_PROMPT_MESSAGE,
	ERROR_MESSAGES,
	LAST_SELECTED_MODEL_KEY,
} from "./constants";
import { extractErrorMessage, extractTokenCountFromError, logError, logger } from "./logger";
import { ModelsClient } from "./models";
import { type EnrichedModelData, ModelEnricher } from "./models/enrichment";
import { parseModelIdentity } from "./models/identity";
import type { TokenStatusBar } from "./status-bar";
import { TokenCache } from "./tokens/cache";
import { TokenCounter } from "./tokens/counter";

/**
 * Set of chunk types that are silently ignored because they have no
 * VS Code LanguageModelResponsePart equivalent.
 *
 * Per RFC 10137 and VS Code API analysis:
 * - LanguageModelResponsePart = LanguageModelTextPart | LanguageModelToolResultPart
 *                              | LanguageModelToolCallPart | LanguageModelDataPart
 * - No LanguageModelThinkingPart exists (reasoning chunks are skipped unless
 *   the unstable API is available)
 * - Source, step, start/finish, abort chunks are streaming metadata only
 *
 * Note: These are fullStream TextStreamPart types, not toUIMessageStream types.
 */
const SILENTLY_IGNORED_CHUNK_TYPES = new Set([
	// Streaming lifecycle events - no content to emit
	"start",
	"finish",
	"abort",
	"start-step",
	"finish-step",
	"reasoning-part-finish",
	// Source references - no VS Code equivalent
	"source",
	// Tool streaming events - we wait for complete tool-call
	"tool-call-streaming-start",
	"tool-call-delta",
	// Tool results only come if we have execute functions (we don't)
	"tool-result",
]);

const MIME_TYPE_PATTERN = /^[a-z]+\/[a-z0-9.+-]+$/i;

export function isValidMimeType(mimeType: string): boolean {
	return MIME_TYPE_PATTERN.test(mimeType);
}

function hashMessage(msg: LanguageModelChatRequestMessage): string {
	const payload = {
		role: msg.role,
		name: msg.name ?? null,
		content: Array.from(msg.content).map((part) => {
			if (part instanceof LanguageModelTextPart) {
				return { type: "text", value: part.value };
			}
			if (part instanceof LanguageModelDataPart) {
				return {
					type: "data",
					mimeType: part.mimeType,
					dataLen: part.data.length,
				};
			}
			if (part instanceof LanguageModelToolCallPart) {
				return { type: "toolCall", name: part.name, callId: part.callId };
			}
			if (part instanceof LanguageModelToolResultPart) {
				return { type: "toolResult", callId: part.callId };
			}
			return { type: "unknown" };
		}),
	};
	return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export class VercelAIChatModelProvider implements LanguageModelChatProvider {
	private context: ExtensionContext;
	private modelsClient: ModelsClient;
	private tokenCache: TokenCache;
	private tokenCounter: TokenCounter;
	private correctionFactor: number = 1.0;
	private lastEstimatedInputTokens: number = 0;
	private configService: ConfigService;
	private enricher: ModelEnricher;
	// Track current request for caching API actuals and status bar
	private currentRequestMessages: readonly LanguageModelChatMessage[] | null = null;
	private currentRequestModelFamily: string | null = null;
	private currentRequestMaxInputTokens: number | undefined = undefined;
	private currentRequestModelId: string | undefined = undefined;
	/**
	 * Learned actual token total from "input too long" errors.
	 * When set, this is distributed across messages proportionally to trigger VS Code summarization.
	 * Keyed by conversation hash to avoid cross-conversation pollution.
	 */
	private learnedTokenTotal: {
		conversationHash: string;
		actualTokens: number;
	} | null = null;
	/**
	 * Tool-call streaming buffer keyed by `toolCallId`.
	 *
	 * Lifecycle:
	 * - Buffer partial tool calls during streaming.
	 * - Flush on stream finish to emit complete tool calls.
	 * - Clear on abort/error (finally block) to avoid stale entries.
	 */
	private toolCallBuffer: Map<string, { toolName: string; argsText: string }> = new Map();
	/** Cache of enriched model data for the session */
	private enrichedModels: Map<string, EnrichedModelData> = new Map();
	private readonly modelInfoChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.modelInfoChangeEmitter.event;
	private statusBar: TokenStatusBar | null = null;

	constructor(context: ExtensionContext, configService: ConfigService = new ConfigService()) {
		this.context = context;
		this.configService = configService;
		this.modelsClient = new ModelsClient(configService);
		this.tokenCache = new TokenCache();
		this.tokenCounter = new TokenCounter();
		this.enricher = new ModelEnricher(configService);
		// Initialize enricher persistence for faster startup
		this.enricher.initializePersistence(context.globalState);
	}

	/**
	 * Set the status bar instance for token usage display.
	 * Called from extension.ts after both provider and status bar are created.
	 */
	setStatusBar(statusBar: TokenStatusBar): void {
		this.statusBar = statusBar;
	}

	dispose(): void {
		this.modelInfoChangeEmitter.dispose();
	}

	private applyEnrichmentToModels(
		models: LanguageModelChatInformation[],
	): LanguageModelChatInformation[] {
		return models.map((model) => {
			const enriched = this.enrichedModels.get(model.id);
			if (!enriched) {
				return model;
			}

			let hasChanges = false;
			const refined: LanguageModelChatInformation = { ...model };

			if (enriched.context_length && enriched.context_length !== model.maxInputTokens) {
				refined.maxInputTokens = enriched.context_length;
				hasChanges = true;
			}

			if (enriched.input_modalities?.includes("image")) {
				refined.capabilities = {
					...(model.capabilities ?? {}),
					imageInput: true,
				};
				hasChanges = true;
			}

			return hasChanges ? refined : model;
		});
	}

	async provideLanguageModelChatInformation(
		options: { silent: boolean },
		_token: CancellationToken,
	): Promise<LanguageModelChatInformation[]> {
		logger.debug("Fetching available models", { silent: options.silent });
		const apiKey = await this.getApiKey(options.silent);
		if (!apiKey) {
			logger.debug("No API key available, returning empty model list");
			return [];
		}

		try {
			const models = await this.modelsClient.getModels(apiKey);
			logger.info(`Loaded ${models.length} models from Vercel AI Gateway`);
			logger.debug(
				"Available models",
				models.map((m) => m.id),
			);
			if (this.configService.modelsEnrichmentEnabled) {
				const enrichedModels = this.applyEnrichmentToModels(models);
				this.triggerBackgroundEnrichment(models, apiKey);
				return enrichedModels;
			}

			return models;
		} catch (error) {
			logger.error(ERROR_MESSAGES.MODELS_FETCH_FAILED, error);
			return [];
		}
	}

	private triggerBackgroundEnrichment(
		models: LanguageModelChatInformation[],
		apiKey: string,
	): void {
		const modelsToEnrich = models.filter((model) => !this.enrichedModels.has(model.id));

		if (modelsToEnrich.length === 0) {
			return;
		}

		Promise.allSettled(
			modelsToEnrich.map((model) => this.enrichModelIfNeeded(model.id, apiKey)),
		).then((results) => {
			const enrichedCount = results.filter(
				(result) => result.status === "fulfilled" && result.value,
			).length;

			if (enrichedCount > 0) {
				logger.debug(
					`Background enrichment completed for ${enrichedCount} models, firing refresh event`,
				);
				this.modelInfoChangeEmitter.fire();
			}
		});
	}

	async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation,
		chatMessages: readonly LanguageModelChatMessage[],
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelResponsePart>,
		token: CancellationToken,
	): Promise<void> {
		// Generate a simple chat ID for per-chat logging (first 8 chars of hash + timestamp)
		const chatHash = createHash("sha256")
			.update(chatMessages.map((m) => m.role + JSON.stringify(m.content)).join("|"))
			.digest("hex")
			.substring(0, 8);
		const chatId = `chat-${chatHash}-${Date.now()}`;

		logger.info(`Chat request to ${model.id} with ${chatMessages.length} messages`);
		logger.debug(`Chat ID: ${chatId}`);

		const abortController = new AbortController();
		const abortSubscription = token.onCancellationRequested(() => abortController.abort());

		let responseSent = false;

		try {
			// Track current request for caching API actuals after response
			this.currentRequestMessages = chatMessages;
			this.currentRequestModelFamily = model.family;
			this.currentRequestMaxInputTokens = model.maxInputTokens;
			this.currentRequestModelId = model.id;

			// Get system prompt configuration for token estimation
			const systemPromptEnabled = this.configService.systemPromptEnabled;
			const systemPromptMessage = this.configService.systemPromptMessage;
			const systemPrompt = systemPromptEnabled
				? systemPromptMessage?.trim()
					? systemPromptMessage
					: DEFAULT_SYSTEM_PROMPT_MESSAGE
				: undefined;

			// Pre-flight check: estimate total tokens and validate against model limit
			// Now includes tool schemas (can be 50k+ tokens) and system prompt overhead
			const estimatedTokens = await this.estimateTotalInputTokens(model, chatMessages, token, {
				tools: options.tools,
				systemPrompt,
			});
			const maxInputTokens = model.maxInputTokens;
			logger.debug(
				`Token estimate: ${estimatedTokens}/${maxInputTokens} (${Math.round((estimatedTokens / maxInputTokens) * 100)}%)`,
			);

			// Pre-flight check: warn if estimated tokens exceed model limit
			// Let the API handle the actual error - estimation may be imprecise
			// and VS Code/consumers may implement their own compaction
			if (estimatedTokens > maxInputTokens) {
				logger.warn(
					`Estimated ${estimatedTokens} tokens exceeds model limit of ${maxInputTokens}. ` +
						`Proceeding anyway - actual token count may differ from estimate.`,
				);
			}

			// Warn if we're close to the limit (>90%)
			if (estimatedTokens > maxInputTokens * 0.9) {
				logger.warn(
					`Input is ${Math.round((estimatedTokens / maxInputTokens) * 100)}% of max tokens. ` +
						`Consider reducing context to avoid potential issues.`,
				);
			}

			this.lastEstimatedInputTokens = estimatedTokens;

			// Show streaming indicator in status bar with estimated tokens
			this.statusBar?.showStreaming(estimatedTokens, maxInputTokens);

			const apiKey = await this.getApiKey(false);
			if (!apiKey) {
				throw new Error(ERROR_MESSAGES.API_KEY_NOT_FOUND);
			}

			// Lazy enrichment: fetch additional metadata on first use of each model
			if (this.configService.modelsEnrichmentEnabled) {
				await this.enrichModelIfNeeded(model.id, apiKey);
			}

			const gateway = createGatewayProvider({
				apiKey,
				baseURL: this.configService.gatewayBaseUrl,
			});

			// Define tools WITHOUT execute functions - VS Code handles tool execution.
			// The AI SDK will emit tool-call events which we forward to VS Code.
			// VS Code then executes tools and sends results back in subsequent messages.
			const tools: ToolSet = {};
			for (const { name, description, inputSchema } of options.tools || []) {
				tools[name] = {
					description,
					inputSchema: jsonSchema(inputSchema || { type: "object", properties: {} }),
					// No execute function - let tool calls flow through to VS Code
				} as unknown as ToolSet[string];
			}

			// Map tool mode correctly
			let toolChoice: "auto" | "required" | "none" = "auto";
			if (options.toolMode === LanguageModelChatToolMode.Required) {
				toolChoice = "required";
			} else if (Object.keys(tools).length === 0) {
				// No tools available, don't force tool use
				toolChoice = "none";
			}

			// Build provider options - add context management for Anthropic models
			const providerOptions = this.buildProviderOptions(model);

			// Note: systemPrompt is computed earlier for token estimation
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const streamOptions: any = {
				model: gateway(model.id),
				system: systemPrompt,
				messages: convertMessages(chatMessages),
				toolChoice,
				temperature: options.modelOptions?.temperature ?? 0.7,
				maxOutputTokens: options.modelOptions?.maxOutputTokens ?? 4096,
				tools: Object.keys(tools).length > 0 ? tools : undefined,
				abortSignal: abortController.signal,
				timeout: this.configService.timeout,
			};

			if (providerOptions) {
				streamOptions.providerOptions = providerOptions;
			}

			const response = streamText(streamOptions);

			// Use fullStream instead of toUIMessageStream() to get tool-call events.
			// toUIMessageStream() hides tool calls and is designed for UI rendering,
			// while fullStream exposes all events needed for VS Code tool execution.
			let chunkCount = 0;
			for await (const chunk of response.fullStream) {
				this.handleStreamChunk(chunk, progress);
				// Track if we've emitted any response content
				if (
					(chunk as { type?: string }).type === "text-delta" ||
					(chunk as { type?: string }).type === "tool-call" ||
					(chunk as { type?: string }).type === "tool-result"
				) {
					responseSent = true;
				}
				chunkCount += 1;
			}

			// Safety check: if we got no chunks or no response was sent, emit something
			if (!responseSent && chunkCount === 0) {
				logger.error(`Stream completed with no chunks for chat ${chatId}`);
				progress.report(
					new LanguageModelTextPart(
						`**Error**: No response received from model. Please try again.`,
					),
				);
			} else if (!responseSent) {
				logger.warn(
					`Stream completed with ${chunkCount} chunks but no content emitted for chat ${chatId}`,
				);
			}

			await this.context.workspaceState.update(LAST_SELECTED_MODEL_KEY, model.id);
			logger.info(`Chat request completed for ${model.id}`);
		} catch (error) {
			// Don't report abort/cancellation as an error - it's expected behavior
			if (this.isAbortError(error)) {
				logger.debug("Request was cancelled");
				return;
			}

			logError("Exception during streaming", error);
			const errorMessage = extractErrorMessage(error);

			// Check if this is a "too long" error we can learn from
			const tokenInfo = extractTokenCountFromError(error);
			if (tokenInfo && this.currentRequestMessages) {
				// Learn the actual token count so we can report accurate counts on retry
				const conversationHash = this.hashConversation(this.currentRequestMessages);
				this.learnedTokenTotal = {
					conversationHash,
					actualTokens: tokenInfo.actualTokens,
				};
				logger.info(
					`Learned actual token count from error: ${tokenInfo.actualTokens} tokens. ` +
						`Firing model info change to trigger VS Code re-evaluation.`,
				);
				// Fire the event so VS Code re-queries token counts
				// This should trigger summarization before the next request
				this.modelInfoChangeEmitter.fire();

				// Show error in status bar with token info
				this.statusBar?.showError(
					`Token limit exceeded: ${tokenInfo.actualTokens.toLocaleString()} tokens ` +
						`(max: ${tokenInfo.maxTokens?.toLocaleString() ?? "unknown"})`,
				);
			}

			// CRITICAL: Always emit an error response to prevent "no response returned" error.
			// If nothing has been sent yet, this is the only response VS Code will see.
			if (!responseSent) {
				logger.error(`Emitting error response for chat ${chatId} due to: ${errorMessage}`);
			}
			progress.report(new LanguageModelTextPart(`\n\n**Error:** ${errorMessage}\n\n`));
		} finally {
			// Clear current request tracking
			this.currentRequestMessages = null;
			this.currentRequestModelFamily = null;
			this.currentRequestMaxInputTokens = undefined;
			this.currentRequestModelId = undefined;
			this.toolCallBuffer.clear();
			abortSubscription.dispose();
		}
	}

	/**
	 * Check if an error is an abort/cancellation error.
	 */
	private isAbortError(error: unknown): boolean {
		if (error instanceof Error) {
			return (
				error.name === "AbortError" ||
				error.message.includes("aborted") ||
				error.message.includes("cancelled") ||
				error.message.includes("canceled")
			);
		}
		return false;
	}

	/**
	 * Create a hash of the conversation for identifying when learned token counts apply.
	 * Uses the first few and last messages to create a stable identifier.
	 */
	private hashConversation(messages: readonly LanguageModelChatMessage[]): string {
		// Use first 2 and last 2 messages for a stable hash
		// This way the hash changes if messages are added but remains stable for same conversation
		const relevant = [...messages.slice(0, 2), ...messages.slice(-2)].filter(Boolean);
		const hashes = relevant.map((msg) => hashMessage(msg as LanguageModelChatRequestMessage));
		return createHash("sha256").update(hashes.join(":")).digest("hex").slice(0, 16);
	}

	/**
	 * Check if a model is an Anthropic/Claude model.
	 */
	private isAnthropicModel(model: LanguageModelChatInformation): boolean {
		const identity = parseModelIdentity(model.id);
		const provider = identity.provider.toLowerCase();
		const family = identity.family.toLowerCase();
		const id = model.id.toLowerCase();
		return (
			provider === "anthropic" ||
			family.includes("claude") ||
			id.includes("claude") ||
			id.includes("anthropic")
		);
	}

	/**
	 * Build provider-specific options based on model capabilities.
	 */
	private buildProviderOptions(
		model: LanguageModelChatInformation,
	): Record<string, unknown> | undefined {
		const options: Record<string, unknown> = {};

		if (this.isAnthropicModel(model)) {
			options.anthropic = {
				// Enable automatic context management to clear old tool uses
				// when approaching context limits
				contextManagement: {
					enabled: true,
				},
			};
		}

		const reasoningOptions = this.getReasoningEffortOptions(model);
		if (reasoningOptions) {
			options.openai = reasoningOptions;
		}

		return Object.keys(options).length > 0 ? options : undefined;
	}

	private getReasoningEffortOptions(
		model: LanguageModelChatInformation,
	): { reasoningEffort: string } | undefined {
		// Check if model supports reasoning via id pattern (o1, o3 models)
		const lowerId = model.id.toLowerCase();
		const supportsReasoning =
			lowerId.includes("o1") || lowerId.includes("o3") || lowerId.includes("reasoning");

		if (!supportsReasoning) {
			return undefined;
		}

		const supportsReasoningEffort =
			lowerId.startsWith("openai/") ||
			lowerId.startsWith("openai:") ||
			lowerId.includes("o1") ||
			lowerId.includes("o3");

		if (!supportsReasoningEffort) {
			return undefined;
		}

		return {
			reasoningEffort: this.configService.reasoningEffort,
		};
	}

	/**
	 * Estimate token count for a message.
	 *
	 * This is called by VS Code BEFORE sending messages to decide whether
	 * to compact/truncate. Accurate estimates are critical for avoiding
	 * "input too long" errors.
	 *
	 * Token counting strategy:
	 * 1. Check if we learned actual counts from a previous "too long" error
	 * 2. Check cache for API actuals (ground truth from previous requests)
	 * 3. Use tiktoken for precise estimation (unsent messages)
	 * 4. Apply safety margins (2% on actuals, 5% on estimates)
	 */
	async provideTokenCount(
		model: LanguageModelChatInformation,
		text: string | LanguageModelChatMessage,
		_token: CancellationToken,
	): Promise<number> {
		// Calculate base estimate first
		let baseEstimate: number;

		if (typeof text === "string") {
			// Use tiktoken for text strings
			const estimated = this.tokenCounter.estimateTextTokens(text, model.family);
			baseEstimate = estimated * this.correctionFactor;
		} else {
			// Check cache for API actuals first (ground truth)
			const cached = this.tokenCache.getCached(text, model.family);
			if (cached !== undefined) {
				// We have ground truth from a previous API response - use with minimal margin
				baseEstimate = cached;
			} else {
				// Use tiktoken-based estimation for unsent messages
				const estimated = this.tokenCounter.estimateMessageTokens(text, model.family);
				baseEstimate = estimated * this.correctionFactor;
			}
		}

		// If we learned from a "too long" error, apply a correction multiplier
		// This ensures VS Code sees token counts that will trigger summarization
		if (this.learnedTokenTotal) {
			// Apply a 1.5x multiplier to compensate for the underestimate
			// The goal is to make the sum exceed maxInputTokens so VS Code summarizes
			const inflated = baseEstimate * 1.5;
			logger.trace(
				`Applying learned token correction: ${baseEstimate} -> ${Math.ceil(inflated)} ` +
					`(learned actual total: ${this.learnedTokenTotal.actualTokens})`,
			);
			return Math.ceil(inflated);
		}

		// Apply standard safety margins
		const margin =
			typeof text === "string" ||
			!this.tokenCache.getCached(text as LanguageModelChatMessage, model.family)
				? this.tokenCounter.usesCharacterFallback(model.family)
					? 0.1
					: 0.05
				: 0.02;
		return this.tokenCounter.applySafetyMargin(baseEstimate, margin);
	}

	/**
	 * Estimate total input tokens for all messages.
	 * Used for pre-flight validation before sending to the API.
	 *
	 * Includes:
	 * - Message content tokens (from cache or estimation)
	 * - Message structure overhead (4 tokens/message)
	 * - Tool schema tokens (16 + 8/tool + content × 1.1)
	 * - System prompt tokens (content + 28 overhead)
	 */
	private async estimateTotalInputTokens(
		model: LanguageModelChatInformation,
		messages: readonly LanguageModelChatMessage[],
		token: CancellationToken,
		options?: {
			tools?: readonly {
				name: string;
				description?: string;
				inputSchema?: unknown;
			}[];
			systemPrompt?: string;
		},
	): Promise<number> {
		// Estimate based on cached actuals and tiktoken/character fallback
		let total = 0;
		for (const message of messages) {
			total += await this.provideTokenCount(model, message, token);
		}
		// Add overhead for message structure (~4 tokens per message)
		total += messages.length * 4;

		// Add tool schema tokens (critical - can be 50k+ tokens)
		if (options?.tools && options.tools.length > 0) {
			const toolTokens = this.tokenCounter.countToolsTokens(options.tools, model.family);
			total += toolTokens;
			logger.debug(`Added ${toolTokens} tokens for ${options.tools.length} tool schemas`);
		}

		// Add system prompt tokens (including 28-token structural overhead)
		if (options?.systemPrompt) {
			const systemTokens = this.tokenCounter.countSystemPromptTokens(
				options.systemPrompt,
				model.family,
			);
			total += systemTokens;
			logger.debug(`Added ${systemTokens} tokens for system prompt`);
		}

		logger.debug(`Total input token estimate: ${total} tokens`);

		return total;
	}

	/**
	 * Cache actual token counts from API response for each message.
	 *
	 * The API returns total input tokens, not per-message counts. We distribute
	 * this across messages proportionally based on our estimates. This ensures
	 * that when a user edits message N, messages 1..N-1 and N+1..end still have
	 * cached actuals available.
	 */
	private cacheMessageTokenCounts(
		messages: readonly LanguageModelChatMessage[],
		modelFamily: string,
		totalInputTokens: number,
	): void {
		if (!messages.length) return;

		// Get our estimates for each message to determine proportions
		const estimates = messages.map((message) =>
			this.tokenCounter.estimateMessageTokens(message, modelFamily),
		);
		const totalEstimated = estimates.reduce((sum, value) => sum + value, 0);

		if (totalEstimated <= 0) {
			// Fallback: distribute evenly if we can't estimate
			const base = Math.floor(totalInputTokens / messages.length);
			let remainder = totalInputTokens - base * messages.length;
			messages.forEach((message) => {
				const extra = remainder > 0 ? 1 : 0;
				remainder = Math.max(0, remainder - extra);
				this.tokenCache.cacheActual(message, modelFamily, base + extra);
			});
			return;
		}

		// Distribute actual tokens proportionally based on estimates
		const allocations = estimates.map((estimate) => (estimate / totalEstimated) * totalInputTokens);
		const floors = allocations.map((value) => Math.floor(value));
		const remaining = totalInputTokens - floors.reduce((sum, value) => sum + value, 0);

		// Distribute remainder to messages with highest fractional parts
		const fractional = allocations
			.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
			.sort((a, b) => b.fraction - a.fraction);

		const actuals = floors.slice();
		for (let i = 0; i < remaining; i += 1) {
			const target = fractional[i % fractional.length];
			if (target) {
				actuals[target.index] += 1;
			}
		}

		// Cache the distributed actual counts
		messages.forEach((message, index) => {
			this.tokenCache.cacheActual(message, modelFamily, actuals[index] ?? 0);
		});

		logger.debug(
			`Cached token counts for ${messages.length} messages (total: ${totalInputTokens})`,
		);
	}

	public getLastSelectedModelId(): string | undefined {
		return this.context.workspaceState.get<string>(LAST_SELECTED_MODEL_KEY);
	}

	private async getApiKey(silent: boolean): Promise<string | undefined> {
		try {
			const session = await authentication.getSession(VERCEL_AI_AUTH_PROVIDER_ID, [], {
				createIfNone: !silent,
				silent,
			});
			return session?.accessToken;
		} catch (error) {
			if (!silent) {
				logger.error("Failed to get authentication session:", error);
				window.showErrorMessage(ERROR_MESSAGES.AUTH_FAILED);
			}
			return undefined;
		}
	}

	/**
	 * Enrich model metadata on first use.
	 *
	 * Fetches additional metadata (context_length, input_modalities, etc.)
	 * from the enrichment endpoint and caches it for the session.
	 * This enables more accurate token limits and capability detection.
	 *
	 * @param modelId - The model ID to enrich
	 * @param apiKey - API key for authentication
	 */
	private async enrichModelIfNeeded(modelId: string, apiKey: string): Promise<boolean> {
		// Skip if already enriched this session
		if (this.enrichedModels.has(modelId)) {
			return false;
		}

		try {
			const enriched = await this.enricher.enrichModel(modelId, apiKey);
			if (enriched) {
				this.enrichedModels.set(modelId, enriched);
				logger.debug(`Enriched model ${modelId}:`, {
					context_length: enriched.context_length,
					input_modalities: enriched.input_modalities,
					supports_implicit_caching: enriched.supports_implicit_caching,
				});
				return true;
			}
		} catch (error) {
			// Non-blocking: enrichment failure shouldn't prevent chat
			logger.warn(`Failed to enrich model ${modelId}`, error);
		}

		return false;
	}

	/**
	 * Get enriched data for a model, if available.
	 */
	public getEnrichedModelData(modelId: string): EnrichedModelData | undefined {
		return this.enrichedModels.get(modelId);
	}

	/**
	 * Handle a single stream chunk from Vercel AI SDK's fullStream.
	 *
	 * Maps Vercel AI TextStreamPart types to VS Code LanguageModelResponsePart:
	 * - text-delta → LanguageModelTextPart
	 * - reasoning-delta → LanguageModelThinkingPart (if available, else skip)
	 * - file → LanguageModelDataPart
	 * - tool-call → LanguageModelToolCallPart (forwarded to VS Code for execution)
	 * - error → LanguageModelTextPart (formatted as error message)
	 * - Other types → Silently ignored (no VS Code equivalent)
	 */
	private handleStreamChunk(
		chunk: StreamChunk,
		progress: Progress<LanguageModelResponsePart>,
	): void {
		switch (chunk.type) {
			case "text-delta": {
				// Accept both 'textDelta' (SDK standard) and 'text' (legacy) field names
				const chunkWithText = chunk as { textDelta?: string; text?: string };
				const textContent = chunkWithText.textDelta ?? chunkWithText.text;
				if (textContent) {
					progress.report(new LanguageModelTextPart(textContent));
				}
				break;
			}

			case "reasoning-delta":
				this.handleReasoningChunk(chunk, progress);
				break;

			case "file":
				// fullStream provides file with GeneratedFile object
				this.handleFileChunk(chunk, progress);
				break;

			case "error":
				this.handleErrorChunk(chunk, progress);
				break;

			case "tool-call":
				// Tool calls come through the stream when execute is not provided.
				// Forward to VS Code which will handle execution.
				this.handleToolCall(chunk, progress);
				break;

			case "tool-call-streaming-start":
				// Start buffering a new streaming tool call
				this.handleToolCallStreamingStart(chunk);
				break;

			case "tool-call-delta":
				// Accumulate streaming tool call arguments
				this.handleToolCallDelta(chunk, progress);
				break;

			// Lifecycle events - no content to emit
			case "start":
			case "start-step":
				break;

			case "abort":
				// Abort means the request was cancelled - discard incomplete tool calls.
				this.toolCallBuffer.clear();
				break;

			case "finish-step": {
				break;
			}

			case "finish": {
				// Flush any buffered tool calls before finishing
				this.flushToolCallBuffer(progress);

				// Clear learned token total since the request succeeded
				// (VS Code must have summarized successfully if we got here)
				if (this.learnedTokenTotal) {
					logger.info("Request succeeded after learning token count - clearing learned total");
					this.learnedTokenTotal = null;
				}

				const finishChunk = chunk as {
					type: "finish";
					totalUsage?: { inputTokens?: number; outputTokens?: number };
					providerMetadata?: {
						anthropic?: {
							contextManagement?: {
								appliedEdits?: Array<{
									type: "clear_tool_uses_20250919" | "clear_thinking_20251015";
									clearedInputTokens: number;
									clearedToolUses?: number;
									clearedThinkingTurns?: number;
								}>;
							};
						};
					};
				};
				const actualInputTokens = finishChunk.totalUsage?.inputTokens;
				if (actualInputTokens !== undefined) {
					// Cache actual token counts for each message (for future cache lookups)
					if (this.currentRequestMessages && this.currentRequestModelFamily) {
						this.cacheMessageTokenCounts(
							this.currentRequestMessages,
							this.currentRequestModelFamily,
							actualInputTokens,
						);
					}
				}
				if (this.lastEstimatedInputTokens > 0 && actualInputTokens !== undefined) {
					const newFactor = actualInputTokens / this.lastEstimatedInputTokens;
					this.correctionFactor = this.correctionFactor * 0.7 + newFactor * 0.3;
					logger.debug(`Correction factor updated: ${this.correctionFactor.toFixed(3)}`);
				}

				// Update status bar with actual token usage
				const outputTokens = finishChunk.totalUsage?.outputTokens ?? 0;
				const appliedEdits =
					finishChunk.providerMetadata?.anthropic?.contextManagement?.appliedEdits;
				if (appliedEdits && appliedEdits.length > 0) {
					const freedTokens = appliedEdits.reduce(
						(total, edit) => total + edit.clearedInputTokens,
						0,
					);
					logger.info(
						`Context compaction applied: ${appliedEdits.length} edit${appliedEdits.length === 1 ? "" : "s"}, freed ${freedTokens.toLocaleString()} tokens`,
					);
				}
				if (actualInputTokens !== undefined) {
					this.statusBar?.showUsage({
						inputTokens: actualInputTokens,
						outputTokens,
						maxInputTokens: this.currentRequestMaxInputTokens,
						modelId: this.currentRequestModelId,
						contextManagement: appliedEdits ? { appliedEdits } : undefined,
					});
				}
				break;
			}

			// Text lifecycle markers
			case "text-start":
			case "text-end":
				break;

			// Reasoning lifecycle
			case "reasoning-start":
			case "reasoning-end":
				break;

			// Source references - no VS Code equivalent
			case "source":
				break;

			// Tool results would only come if we had execute functions
			case "tool-result":
				break;

			// Tool input lifecycle - we wait for complete tool-call
			case "tool-input-start":
			case "tool-input-delta":
				break;

			default:
				this.handleUnknownChunk(chunk, progress);
				break;
		}
	}

	/**
	 * Handle reasoning chunks using the unstable LanguageModelThinkingPart.
	 *
	 * This constructor is not in the stable VS Code API, so we use dynamic lookup.
	 * If the constructor doesn't exist, the reasoning content is silently skipped
	 * (there's no equivalent stable API surface).
	 */
	private handleReasoningChunk(
		chunk: { type: "reasoning-delta"; delta?: string; text?: string },
		progress: Progress<LanguageModelResponsePart>,
	): void {
		const vsAny = vscode as unknown as Record<string, unknown>;
		const ThinkingCtor = vsAny.LanguageModelThinkingPart as
			| (new (
					text: string,
					id?: string,
					metadata?: unknown,
			  ) => unknown)
			| undefined;

		// Accept both 'delta' (SDK standard) and 'text' (legacy) field names
		const reasoningText = chunk.delta ?? chunk.text;
		if (ThinkingCtor && reasoningText) {
			progress.report(
				new (ThinkingCtor as new (text: string) => LanguageModelResponsePart)(reasoningText),
			);
		}
		// If ThinkingCtor doesn't exist, silently skip - no stable API equivalent
	}

	/**
	 * Handle tool-call chunks from the AI SDK stream.
	 *
	 * When tools are defined without execute functions, the SDK emits tool-call
	 * events that we forward to VS Code as LanguageModelToolCallPart.
	 * VS Code then handles tool execution and sends results back.
	 */
	private handleToolCall(
		chunk: {
			type: "tool-call";
			toolCallId: string;
			toolName: string;
			args?: unknown;
			input?: unknown;
		},
		progress: Progress<LanguageModelResponsePart>,
	): void {
		const buffered = this.toolCallBuffer.get(chunk.toolCallId);

		// Accept both 'args' (new SDK) and 'input' (legacy) field names
		let toolInput = (chunk.args ?? chunk.input) as Record<string, unknown> | undefined;

		// Fallback to buffered args if the final tool-call chunk omits args/input
		if (toolInput === undefined && buffered) {
			try {
				toolInput = JSON.parse(buffered.argsText || "{}") as Record<string, unknown>;
			} catch (error) {
				logger.error(
					`Failed to parse buffered tool call args for ${chunk.toolCallId}: ${buffered.argsText}`,
					error,
				);
				toolInput = {};
			}
		}

		// If this tool call was buffered from streaming, remove it from buffer
		// to avoid duplicate emission
		if (buffered) {
			this.toolCallBuffer.delete(chunk.toolCallId);
		}

		progress.report(new LanguageModelToolCallPart(chunk.toolCallId, chunk.toolName, toolInput));
		logger.debug(`Tool call emitted: ${chunk.toolName} (${chunk.toolCallId})`);
	}

	/**
	 * Handle tool-call-streaming-start by initializing a buffer entry.
	 */
	private handleToolCallStreamingStart(chunk: {
		type: "tool-call-streaming-start";
		toolCallId: string;
		toolName: string;
	}): void {
		this.toolCallBuffer.set(chunk.toolCallId, {
			toolName: chunk.toolName,
			argsText: "",
		});
		logger.debug(`Tool call streaming started: ${chunk.toolCallId} (${chunk.toolName})`);
	}

	/**
	 * Handle tool-call-delta by accumulating arguments text.
	 * Emit complete tool call if this is the final delta (no more deltas expected).
	 */
	private handleToolCallDelta(
		chunk: {
			type: "tool-call-delta";
			toolCallId: string;
			argsTextDelta: string;
		},
		progress: Progress<LanguageModelResponsePart>,
	): void {
		const buffered = this.toolCallBuffer.get(chunk.toolCallId);
		if (!buffered) {
			logger.warn(`Tool call delta for unknown toolCallId: ${chunk.toolCallId}`);
			return;
		}

		// Accumulate the delta
		buffered.argsText += chunk.argsTextDelta;
		logger.debug(
			`Tool call delta accumulated: ${chunk.toolCallId} (${buffered.argsText.length} chars)`,
		);

		// Note: We don't emit here - we wait for either:
		// 1. A final 'tool-call' chunk (which will find and remove from buffer)
		// 2. Stream 'finish' event (which flushes all buffered calls)
		// This prevents emitting incomplete tool calls
	}

	/**
	 * Flush any remaining buffered tool calls at stream end.
	 * This handles cases where streaming started but no final 'tool-call' chunk arrived.
	 */
	private flushToolCallBuffer(progress: Progress<LanguageModelResponsePart>): void {
		for (const [toolCallId, buffered] of this.toolCallBuffer.entries()) {
			try {
				// Parse accumulated args text as JSON
				const toolInput = JSON.parse(buffered.argsText || "{}") as Record<string, unknown>;

				progress.report(new LanguageModelToolCallPart(toolCallId, buffered.toolName, toolInput));

				logger.debug(`Flushed buffered tool call: ${toolCallId} (${buffered.toolName})`);
			} catch (error) {
				logger.error(
					`Failed to parse buffered tool call args for ${toolCallId}: ${buffered.argsText}`,
					error,
				);
			}
		}

		// Clear buffer after flushing
		this.toolCallBuffer.clear();
	}

	/**
	 * Handle file chunks by mapping to LanguageModelDataPart.
	 *
	 * fullStream provides files with a GeneratedFile object containing:
	 * - base64: string (base64 encoded content)
	 * - uint8Array: Uint8Array (binary content)
	 * - mediaType: string (MIME type)
	 *
	 * We use the appropriate LanguageModelDataPart factory method based on the media type:
	 * - Images: LanguageModelDataPart.image()
	 * - Text: LanguageModelDataPart.text()
	 * - JSON: LanguageModelDataPart.json()
	 * - Other: Raw LanguageModelDataPart constructor
	 */
	private handleFileChunk(
		chunk: {
			type: "file";
			file: { base64: string; uint8Array: Uint8Array; mediaType: string };
		},
		progress: Progress<LanguageModelResponsePart>,
	): void {
		const mimeType = chunk.file?.mediaType;
		if (!mimeType || !isValidMimeType(mimeType)) {
			logger.warn(`Unsupported file mime type: ${mimeType ?? "unknown"}`);
			return;
		}

		try {
			const dataPart = this.createDataPartForMimeType(chunk.file.uint8Array, mimeType);
			progress.report(dataPart);
		} catch (error) {
			logger.warn("Failed to process file chunk:", error);
		}
	}

	/**
	 * Create the appropriate LanguageModelDataPart based on MIME type.
	 */
	private createDataPartForMimeType(data: Uint8Array, mimeType: string): LanguageModelDataPart {
		// Use image() for image types to preserve binary data
		if (mimeType.startsWith("image/")) {
			return LanguageModelDataPart.image(data, mimeType);
		}

		// Use json() for JSON content
		if (mimeType === "application/json" || mimeType.endsWith("+json")) {
			try {
				const jsonValue = JSON.parse(new TextDecoder().decode(data));
				return LanguageModelDataPart.json(jsonValue, mimeType);
			} catch {
				// Fall through to text if JSON parsing fails
			}
		}

		// Use text() for text types
		if (
			mimeType.startsWith("text/") ||
			mimeType === "application/xml" ||
			mimeType.endsWith("+xml")
		) {
			return LanguageModelDataPart.text(new TextDecoder().decode(data), mimeType);
		}

		// For other types, use raw constructor
		return new LanguageModelDataPart(data, mimeType);
	}

	/**
	 * Handle error chunks by emitting a formatted error message as text.
	 */
	private handleErrorChunk(
		chunk: { type: "error"; error: unknown },
		progress: Progress<LanguageModelResponsePart>,
	): void {
		logError("Stream error chunk received", chunk.error);
		const errorMessage = extractErrorMessage(chunk.error);
		progress.report(new LanguageModelTextPart(`\n\n**Error:** ${errorMessage}\n\n`));
	}

	/**
	 * Handle unknown/unmapped chunk types.
	 *
	 * Chunks in SILENTLY_IGNORED_CHUNK_TYPES are expected and logged at debug level.
	 * Truly unknown chunks are logged as warnings to help identify API changes.
	 */
	private handleUnknownChunk(
		chunk: StreamChunk,
		_progress: Progress<LanguageModelResponsePart>,
	): void {
		const chunkType = (chunk as { type?: string }).type;

		if (chunkType && SILENTLY_IGNORED_CHUNK_TYPES.has(chunkType)) {
			// Expected chunk type with no VS Code equivalent - debug log only
			logger.trace(`Ignored expected chunk type: ${chunkType}`);
		} else if (chunkType?.startsWith("data-")) {
			// Custom data chunks - silently ignore
			logger.trace(`Ignored data chunk type: ${chunkType}`);
		} else {
			// Truly unknown chunk type - warn to help identify API changes
			logger.warn(`Unknown stream chunk type: ${chunkType}`, chunk);
		}
	}
}

export function convertMessages(messages: readonly LanguageModelChatMessage[]): ModelMessage[] {
	// First pass: build a mapping of toolCallId -> toolName from all tool call parts
	const toolNameMap: Record<string, string> = {};
	for (const msg of messages) {
		for (const part of msg.content) {
			if (part instanceof LanguageModelToolCallPart) {
				toolNameMap[part.callId] = part.name;
			}
		}
	}

	// Second pass: convert messages, passing the tool name map for result lookups
	const result = messages
		.flatMap((msg) => convertSingleMessage(msg, toolNameMap))
		.filter(isValidMessage);
	fixSystemMessages(result);
	return result;
}

export function convertSingleMessage(
	msg: LanguageModelChatMessage,
	toolNameMap: Record<string, string>,
): ModelMessage[] {
	const results: ModelMessage[] = [];
	const role = msg.role === LanguageModelChatMessageRole.User ? "user" : "assistant";

	// Collect multi-modal content parts for a single message
	const contentParts: Array<{
		type: string;
		text?: string;
		image?: string;
		mimeType?: string;
	}> = [];

	for (const part of msg.content) {
		if (typeof part === "object" && part !== null) {
			if (isTextPart(part)) {
				contentParts.push({ type: "text", text: part.value });
			} else if (part instanceof LanguageModelDataPart) {
				if (part.mimeType.startsWith("image/")) {
					// Handle image parts - convert to base64 data URL for Vercel AI SDK
					const base64Data = Buffer.from(part.data).toString("base64");
					const dataUrl = `data:${part.mimeType};base64,${base64Data}`;
					contentParts.push({
						type: "image",
						image: dataUrl,
						mimeType: part.mimeType,
					});
				} else {
					const decodedText = new TextDecoder().decode(part.data);
					contentParts.push({ type: "text", text: decodedText });
				}
			} else if (part instanceof LanguageModelToolCallPart) {
				// Flush any accumulated content parts first
				if (contentParts.length > 0) {
					results.push(createMultiModalMessage(role, contentParts));
					contentParts.length = 0;
				}
				results.push({
					role: "assistant",
					content: [
						{
							type: "tool-call",
							toolName: part.name,
							toolCallId: part.callId,
							input: part.input,
						},
					],
				});
			} else if (part instanceof LanguageModelToolResultPart) {
				// Flush any accumulated content parts first
				if (contentParts.length > 0) {
					results.push(createMultiModalMessage(role, contentParts));
					contentParts.length = 0;
				}
				const resultTexts = extractToolResultTexts(part);
				if (resultTexts.length > 0) {
					// Look up the tool name from the mapping built in convertMessages
					const toolName = toolNameMap[part.callId] || "unknown_tool";
					if (!toolNameMap[part.callId]) {
						logger.warn(`No tool name found for callId ${part.callId}, using fallback`);
					}
					results.push({
						role: "tool",
						content: [
							{
								type: "tool-result" as const,
								toolCallId: part.callId,
								toolName,
								output: {
									type: "text" as const,
									value: resultTexts.join(" "),
								},
							},
						],
					});
				}
			}
		}
	}

	// Flush any remaining content parts
	if (contentParts.length > 0) {
		results.push(createMultiModalMessage(role, contentParts));
	}

	if (results.length === 0) {
		logger.debug("Message had no valid content, creating placeholder");
		results.push({ role, content: "" });
	}

	return results;
}

/**
 * Create a multi-modal message from content parts.
 * If there's only text, return a simple string content.
 * If there are images, return an array of content parts.
 *
 * Note: Images can only be in user messages per the Vercel AI SDK.
 * If images appear in assistant/system messages, they will be converted to
 * text placeholders.
 */
function createMultiModalMessage(
	role: "user" | "assistant" | "system",
	parts: Array<{
		type: string;
		text?: string;
		image?: string;
		mimeType?: string;
	}>,
): ModelMessage {
	// If only text parts, combine into a single string
	const textOnly = parts.every((p) => p.type === "text");
	if (textOnly) {
		return {
			role,
			content: parts.map((p) => p.text).join(""),
		};
	}

	// Images can only be in user messages
	if (role === "user") {
		return {
			role: "user" as const,
			content: parts.map((p) => {
				if (p.type === "text") {
					return { type: "text" as const, text: p.text! };
				}
				return { type: "image" as const, image: p.image! };
			}),
		};
	}

	// For non-user roles, convert images to placeholder text
	logger.warn(`Images in ${role} messages are not supported, converting to placeholder`);
	return {
		role,
		content: parts.map((p) => (p.type === "text" ? p.text : "[Image content]")).join(""),
	};
}

function isTextPart(part: object): part is { value: string } {
	return "value" in part && typeof (part as { value: unknown }).value === "string";
}

function extractToolResultTexts(part: LanguageModelToolResultPart): string[] {
	return part.content
		.filter(
			(resultPart): resultPart is { value: string } =>
				typeof resultPart === "object" && resultPart !== null && "value" in resultPart,
		)
		.map((resultPart) => resultPart.value);
}

function isValidMessage(msg: ModelMessage): boolean {
	return typeof msg.content === "string"
		? msg.content.trim().length > 0
		: Array.isArray(msg.content)
			? msg.content.length > 0
			: false;
}

function fixSystemMessages(result: ModelMessage[]): void {
	const firstUserIndex = result.findIndex((msg) => msg.role === "user");
	for (let i = 0; i < firstUserIndex; i++) {
		if (result[i].role === "assistant") {
			result[i].role = "system";
		}
	}
}
