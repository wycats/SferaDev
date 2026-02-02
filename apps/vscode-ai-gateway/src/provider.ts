import { createHash } from "node:crypto";
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
  LanguageModelDataPart,
  type LanguageModelResponsePart,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  type Progress,
  type ProvideLanguageModelChatResponseOptions,
  window,
} from "vscode";

import { CONSERVATIVE_MAX_INPUT_TOKENS } from "./constants";

import { VERCEL_AI_AUTH_PROVIDER_ID } from "./auth";
import { ConfigService } from "./config";
import { ERROR_MESSAGES, LAST_SELECTED_MODEL_KEY } from "./constants";
import {
  extractErrorMessage,
  extractTokenCountFromError,
  logError,
  logger,
} from "./logger";
import { ModelsClient } from "./models";
import { type EnrichedModelData, ModelEnricher } from "./models/enrichment";
import { captureForensicData } from "./provider/forensic-capture.js";
import { executeOpenResponsesChat } from "./provider/openresponses-chat.js";
import { extractSystemPrompt } from "./provider/system-prompt.js";
import {
  computeAgentTypeHash,
  computeToolSetHash,
  hashUserMessage,
} from "./identity";
import type { TokenStatusBar } from "./status-bar";
import { HybridTokenEstimator } from "./tokens/hybrid-estimator";

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
  private tokenEstimator: HybridTokenEstimator;
  private configService: ConfigService;
  private enricher: ModelEnricher;
  // Track current request for caching API actuals and status bar
  private currentRequestMessages: readonly LanguageModelChatMessage[] | null =
    null;
  /**
   * Learned actual token total from "input too long" errors.
   * When set, this is distributed across messages proportionally to trigger VS Code summarization.
   * Keyed by conversation hash to avoid cross-conversation pollution.
   */
  private learnedTokenTotal: {
    conversationHash: string;
    actualTokens: number;
  } | null = null;
  /** Cache of enriched model data for the session */
  private enrichedModels = new Map<string, EnrichedModelData>();
  private readonly modelInfoChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation =
    this.modelInfoChangeEmitter.event;
  private statusBar: TokenStatusBar | null = null;
  /** Current agent ID for status bar tracking */
  private currentAgentId: string | null = null;

  constructor(
    context: ExtensionContext,
    configService: ConfigService = new ConfigService(),
  ) {
    this.context = context;
    this.configService = configService;
    this.modelsClient = new ModelsClient(configService);
    this.tokenEstimator = new HybridTokenEstimator(context);
    this.enricher = new ModelEnricher(configService);
    // Initialize enricher persistence for faster startup
    this.enricher.initializePersistence(context.globalState);
    // Initialize models client persistence for instant model availability on reload
    // The callback fires when models are updated in the background, triggering VS Code refresh
    this.modelsClient.initializePersistence(context.globalState, () => {
      this.modelInfoChangeEmitter.fire();
    });
  }

  /**
   * Set the status bar instance for token usage display.
   * Called from extension.ts after both provider and status bar are created.
   */
  setStatusBar(statusBar: TokenStatusBar): void {
    this.statusBar = statusBar;
  }

  /**
   * Record actual token count from API response.
   * Called after successful chat responses with actual usage data.
   *
   * This enables delta-based estimation: for subsequent requests that extend
   * this conversation, we use knownTotal + tiktoken(new messages only).
   */
  recordUsage(
    model: LanguageModelChatInformation,
    messages: readonly LanguageModelChatMessage[],
    actualInputTokens: number,
    conversationId?: string,
  ): void {
    this.tokenEstimator.recordActual(
      messages,
      model,
      actualInputTokens,
      conversationId,
    );

    // Update status bar with estimation state
    const state = this.tokenEstimator.getConversationState(
      model.family,
      conversationId,
    );
    if (state && this.statusBar) {
      logger.info(
        `[TokenState] ${model.family}: ${state.actualTokens.toString()} tokens ` +
          `for ${state.messageHashes.length.toString()} messages`,
      );
    }
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

      // Check if we need to apply any enrichment
      // Only apply context_length if it's a positive number (not null)
      // BUT cap it at CONSERVATIVE_MAX_INPUT_TOKENS to prevent high-context degradation
      const enrichedContextLength = enriched.context_length;
      const cappedContextLength =
        typeof enrichedContextLength === "number" && enrichedContextLength > 0
          ? Math.min(enrichedContextLength, CONSERVATIVE_MAX_INPUT_TOKENS)
          : null;
      const needsContextLength =
        cappedContextLength !== null &&
        cappedContextLength !== model.maxInputTokens;
      const needsImageInput =
        enriched.input_modalities.includes("image") &&
        !model.capabilities.imageInput;

      if (!needsContextLength && !needsImageInput) {
        return model;
      }

      // Create a new object with enriched properties (properties are readonly)
      return {
        ...model,
        ...(needsContextLength ? { maxInputTokens: cappedContextLength } : {}),
        ...(needsImageInput
          ? {
              capabilities: {
                ...model.capabilities,
                imageInput: true,
              },
            }
          : {}),
      };
    });
  }

  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    _token: CancellationToken,
  ): Promise<LanguageModelChatInformation[]> {
    void _token;
    logger.debug("Fetching available models", { silent: options.silent });

    // VS Code calls this with `silent: true` during reload/startup.
    // Do NOT block on auth/network in that path: returning cached models immediately
    // avoids the model picker briefly clearing while auth initializes.
    const cachedModels = this.modelsClient.getCachedModels();
    if (options.silent && cachedModels.length > 0) {
      logger.debug(
        `Silent model query: returning ${cachedModels.length.toString()} cached models immediately`,
      );

      // Kick off a background revalidation once auth is available.
      // This should not cause flicker because we only fire change events when model IDs change.
      void this.getApiKey(true).then((apiKey) => {
        if (!apiKey) return;
        void this.modelsClient.getModels(apiKey);
      });

      if (this.configService.modelsEnrichmentEnabled) {
        return this.applyEnrichmentToModels(cachedModels);
      }
      return cachedModels;
    }

    const apiKey = await this.getApiKey(options.silent);
    if (!apiKey) {
      // Auth temporarily unavailable - return cached models to prevent picker flicker
      if (cachedModels.length > 0) {
        logger.debug(
          `No API key available, returning ${cachedModels.length.toString()} cached models`,
        );
        // Apply any enrichment we have from the previous session
        if (this.configService.modelsEnrichmentEnabled) {
          logger.debug("Applying cached model enrichment during auth gap");
          return this.applyEnrichmentToModels(cachedModels);
        }
        return cachedModels;
      }
      logger.debug(
        "No API key available and no cached models, returning empty list",
      );
      return [];
    }

    try {
      const models = await this.modelsClient.getModels(apiKey);
      logger.info(
        `Loaded ${models.length.toString()} models from Vercel AI Gateway`,
      );
      logger.debug(
        "Available models",
        models.map((m) => m.id),
      );
      if (this.configService.modelsEnrichmentEnabled) {
        // Avoid background enrichment + forced refresh events here: VS Code appears
        // to briefly clear the model picker UI on `onDidChangeLanguageModelChatInformation`.
        // We still apply any already-known enrichment, and do lazy enrichment on first use.
        return this.applyEnrichmentToModels(models);
      }

      return models;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(ERROR_MESSAGES.MODELS_FETCH_FAILED, { error: errorMessage });
      return [];
    }
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
      .update(
        chatMessages
          .map((m) => `${String(m.role)}${JSON.stringify(m.content)}`)
          .join("|"),
      )
      .digest("hex")
      .substring(0, 8);
    const chatId = `chat-${chatHash}-${Date.now().toString()}`;

    // Log session ID at entry point to identify which window handles each request
    const sessionId = vscode.env.sessionId.substring(0, 8);
    logger.info(
      `[${sessionId}] Chat request to ${model.id} with ${chatMessages.length.toString()} messages`,
    );
    logger.debug(`[${sessionId}] Chat ID: ${chatId}`);

    const abortController = new AbortController();
    const abortSubscription = token.onCancellationRequested(() => {
      abortController.abort();
    });

    let responseSent = false;

    try {
      // Track current request for caching API actuals after response
      this.currentRequestMessages = chatMessages;

      // Extract system prompt for subagent detection
      const systemPrompt = extractSystemPrompt(chatMessages);
      const systemPromptHash = systemPrompt
        ? createHash("sha256")
            .update(systemPrompt)
            .digest("hex")
            .substring(0, 16)
        : undefined;

      // Pre-flight check: estimate total tokens and validate against model limit
      // Now includes tool schemas (can be 50k+ tokens)
      const estimatedTokens = this.estimateTotalInputTokens(
        model,
        chatMessages,
        token,
        systemPromptHash,
        options.tools ? { tools: options.tools } : {},
      );
      const maxInputTokens = model.maxInputTokens;
      logger.debug(
        `Token estimate: ${estimatedTokens.toString()}/${String(maxInputTokens)} (${Math.round((estimatedTokens / maxInputTokens) * 100).toString()}%)`,
      );

      // Forensic capture for debugging conversation identifiers
      if (this.configService.forensicCaptureEnabled) {
        await captureForensicData({
          model,
          chatMessages,
          options,
          systemPrompt,
          systemPromptHash,
          estimatedTokens,
          chatId,
          currentAgentId: this.currentAgentId,
        });
      }

      // Pre-flight check: warn if estimated tokens exceed model limit
      // Let the API handle the actual error - estimation may be imprecise
      // and VS Code/consumers may implement their own compaction
      if (estimatedTokens > maxInputTokens) {
        logger.warn(
          `Estimated ${estimatedTokens.toString()} tokens exceeds model limit of ${String(maxInputTokens)}. ` +
            `Proceeding anyway - actual token count may differ from estimate.`,
        );
      }

      // Warn if we're close to the limit (>90%)
      if (estimatedTokens > maxInputTokens * 0.9) {
        logger.warn(
          `Input is ${Math.round((estimatedTokens / maxInputTokens) * 100).toString()}% of max tokens. ` +
            `Consider reducing context to avoid potential issues.`,
        );
      }

      // Gather empirical data for subagent detection
      const messageRoles = chatMessages.map((m) => m.role).join(",");
      const toolNames = options.tools?.map((t) => t.name).slice(0, 10) ?? [];
      const hasActiveStreaming = this.currentAgentId !== null;

      // Get VS Code's session ID to identify which window this request is from
      const vscodeSessionId = vscode.env.sessionId;
      const shortSessionId = vscodeSessionId.substring(0, 8);

      // Safe preview extraction - avoid calling .replace() on undefined
      const systemPromptPreview = systemPrompt
        ? systemPrompt.substring(0, 300).replace(/\n/g, "\\n")
        : undefined;

      logger.info(
        `[Subagent Detection] Request analysis`,
        JSON.stringify({
          chatId,
          vscodeSessionId: shortSessionId,
          messageCount: chatMessages.length,
          messageRoles: messageRoles.substring(0, 100),
          systemPromptHash,
          systemPromptLen: systemPrompt?.length ?? 0,
          systemPromptPreview,
          toolCount: options.tools?.length ?? 0,
          toolNames,
          hasActiveStreaming,
          currentAgentId: this.currentAgentId?.slice(-12),
        }),
      );

      // Start tracking this agent in the status bar
      const toolSetHash = computeToolSetHash(options.tools ?? []);
      const agentTypeHash = systemPromptHash
        ? computeAgentTypeHash(systemPromptHash, toolSetHash)
        : undefined;
      const firstUserMessage = chatMessages.find((m) => m.role === LanguageModelChatMessageRole.User);
      const firstUserMessageText = firstUserMessage
        ? Array.from(firstUserMessage.content)
            .filter((part) => part instanceof LanguageModelTextPart)
            .map((part) => part.value)
            .join("")
        : undefined;
      const firstUserMessageHash = firstUserMessageText
        ? hashUserMessage(firstUserMessageText)
        : undefined;
      this.currentAgentId = chatId;
      this.statusBar?.startAgent(
        chatId,
        estimatedTokens,
        maxInputTokens,
        model.id,
        systemPromptHash,
        agentTypeHash,
        firstUserMessageHash,
      );

      const apiKey = await this.getApiKey(false);
      if (!apiKey) {
        throw new Error(ERROR_MESSAGES.API_KEY_NOT_FOUND);
      }

      // Lazy enrichment: fetch additional metadata on first use of each model
      if (this.configService.modelsEnrichmentEnabled) {
        await this.enrichModelIfNeeded(model.id, apiKey);
      }

      // Execute chat using OpenResponses API
      logger.debug(`[OpenResponses] Executing chat request for ${model.id}`);
      const result = await executeOpenResponsesChat(
        model,
        chatMessages,
        options,
        progress,
        token,
        {
          configService: this.configService,
          statusBar: this.statusBar,
          apiKey,
          estimatedInputTokens: estimatedTokens,
          chatId,
          onUsage: (actualInputTokens) => {
            // Record actual tokens for delta estimation
            this.recordUsage(
              model,
              chatMessages,
              actualInputTokens,
              systemPromptHash,
            );
          },
        },
      );

      // Track if we sent a response (for error handling)
      responseSent = result.success;

      // Update last selected model on success
      if (result.success) {
        await this.context.workspaceState.update(
          LAST_SELECTED_MODEL_KEY,
          model.id,
        );
        logger.info(`[OpenResponses] Chat request completed for ${model.id}`);

        // Clear learned token total on success - summarization worked, we're back to normal
        // This prevents infinite summarization loops where inflated counts keep triggering
        // more summarization even after the context has been reduced.
        if (this.learnedTokenTotal) {
          logger.debug(
            `Clearing learned token total after successful request ` +
              `(was: ${this.learnedTokenTotal.actualTokens.toString()} tokens)`,
          );
          this.learnedTokenTotal = null;
        }
      }
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
        const conversationHash = this.hashConversation(
          this.currentRequestMessages,
        );
        this.learnedTokenTotal = {
          conversationHash,
          actualTokens: tokenInfo.actualTokens,
        };
        logger.info(
          `Learned actual token count from error: ${tokenInfo.actualTokens.toString()} tokens. ` +
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
        if (this.currentAgentId) {
          this.statusBar?.errorAgent(this.currentAgentId);
        }
      }

      // Mark agent as errored in status bar (even if we didn't extract token info)
      // This ensures agents don't get stuck in 'streaming' state on any error
      if (this.currentAgentId && !tokenInfo) {
        this.statusBar?.errorAgent(this.currentAgentId);
      }

      // CRITICAL: Always emit an error response to prevent "no response returned" error.
      // If nothing has been sent yet, this is the only response VS Code will see.
      if (!responseSent) {
        logger.error(
          `Emitting error response for chat ${chatId} due to: ${errorMessage}`,
        );
      }
      progress.report(
        new LanguageModelTextPart(`\n\n**Error:** ${errorMessage}\n\n`),
      );
    } finally {
      // Clear current request tracking
      this.currentRequestMessages = null;
      this.currentAgentId = null;
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
  private hashConversation(
    messages: readonly LanguageModelChatMessage[],
  ): string {
    // Use first 2 and last 2 messages for a stable hash
    // This way the hash changes if messages are added but remains stable for same conversation
    const relevant = [...messages.slice(0, 2), ...messages.slice(-2)].filter(
      Boolean,
    );
    const hashes = relevant.map((msg) =>
      hashMessage(msg as LanguageModelChatRequestMessage),
    );
    return createHash("sha256")
      .update(hashes.join(":"))
      .digest("hex")
      .slice(0, 16);
  }

  /**
   * Estimate token count for a single message.
   *
   * This is called by VS Code BEFORE sending messages to decide whether
   * to compact/truncate. For per-message estimation, we use tiktoken.
   *
   * Note: The more accurate conversation-level delta estimation is used
   * in estimateTotalInputTokens() for our internal pre-flight checks.
   * VS Code's per-message calls don't have conversation context.
   */
  provideTokenCount(
    model: LanguageModelChatInformation,
    text: string | LanguageModelChatMessage,
    _token: CancellationToken,
  ): Promise<number> {
    void _token;

    // Use tiktoken for per-message estimation
    const estimate = this.tokenEstimator.estimateMessage(text, model);

    // If we learned from a "too long" error, apply a correction multiplier
    // This ensures VS Code sees token counts that will trigger summarization
    // Only apply if we're still in the same conversation (check hash to avoid cross-pollution)
    if (this.learnedTokenTotal && this.currentRequestMessages) {
      const currentHash = this.hashConversation(this.currentRequestMessages);
      if (currentHash === this.learnedTokenTotal.conversationHash) {
        // Apply a 1.5x multiplier to compensate for the underestimate
        // The goal is to make the sum exceed maxInputTokens so VS Code summarizes
        const inflated = estimate * 1.5;
        logger.trace(
          `Applying learned token correction: ${estimate.toString()} -> ${Math.ceil(inflated).toString()} ` +
            `(learned actual total: ${this.learnedTokenTotal.actualTokens.toString()})`,
        );
        return Promise.resolve(Math.ceil(inflated));
      } else {
        // Different conversation - clear the stale learned total
        logger.debug(
          `Clearing stale learned token total (conversation hash mismatch: ` +
            `${currentHash} !== ${this.learnedTokenTotal.conversationHash})`,
        );
        this.learnedTokenTotal = null;
      }
    }

    return Promise.resolve(estimate);
  }

  /**
   * Estimate total input tokens for all messages.
   * Used for pre-flight validation before sending to the API.
   *
   * Includes:
   * - Message content tokens (from delta estimation or tiktoken)
   * - Message structure overhead (included in delta estimation)
   * - Tool schema tokens (16 + 8/tool + content × 1.1)
   * - System prompt tokens (content + 28 overhead)
   *
   * Uses delta-based estimation when we have a known conversation state:
   * - If messages exactly match known state → return actual (ground truth)
   * - If messages extend known state → knownTotal + tiktoken(new messages)
   * - Otherwise → tiktoken for all messages
   */
  private estimateTotalInputTokens(
    model: LanguageModelChatInformation,
    messages: readonly LanguageModelChatMessage[],
    _token: CancellationToken,
    conversationId?: string,
    options?: {
      tools?: readonly {
        name: string;
        description?: string;
        inputSchema?: unknown;
      }[];
      systemPrompt?: string;
    },
  ): number {
    void _token;

    // Use conversation-level delta estimation
    const estimate = this.tokenEstimator.estimateConversation(
      messages,
      model,
      conversationId,
    );

    let total = estimate.tokens;
    const sourceLabel =
      estimate.source === "exact"
        ? "ground truth"
        : estimate.source === "delta"
          ? `delta (${estimate.knownTokens.toString()} known + ${estimate.estimatedTokens.toString()} est)`
          : "full estimate";

    logger.debug(
      `Message tokens: ${total.toString()} (${sourceLabel}, ` +
        `${messages.length.toString()} messages, ${estimate.newMessageCount.toString()} new)`,
    );

    // Add tool schema tokens (critical - can be 50k+ tokens)
    const tokenCounter = this.tokenEstimator.getTokenCounter();
    if (options?.tools && options.tools.length > 0) {
      const toolTokens = tokenCounter.countToolsTokens(
        options.tools,
        model.family,
      );
      total += toolTokens;
      logger.debug(
        `Added ${toolTokens.toString()} tokens for ${options.tools.length.toString()} tool schemas`,
      );
    }

    // Add system prompt tokens (including 28-token structural overhead)
    if (options?.systemPrompt) {
      const systemTokens = tokenCounter.countSystemPromptTokens(
        options.systemPrompt,
        model.family,
      );
      total += systemTokens;
      logger.debug(`Added ${systemTokens.toString()} tokens for system prompt`);
    }

    logger.debug(`Total input token estimate: ${total.toString()} tokens`);

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
  public getLastSelectedModelId(): string | undefined {
    return this.context.workspaceState.get<string>(LAST_SELECTED_MODEL_KEY);
  }

  private async getApiKey(silent: boolean): Promise<string | undefined> {
    // Test mode: allow API key from environment variable
    // Check both VERCEL_API_KEY and OPENRESPONSES_API_KEY for flexibility
    const envApiKey =
      process.env["VERCEL_API_KEY"] ?? process.env["OPENRESPONSES_API_KEY"];
    if (envApiKey) {
      logger.debug("Using API key from environment variable");
      return envApiKey;
    }

    try {
      const session = await authentication.getSession(
        VERCEL_AI_AUTH_PROVIDER_ID,
        [],
        {
          createIfNone: !silent,
          silent,
        },
      );
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
  private async enrichModelIfNeeded(
    modelId: string,
    apiKey: string,
  ): Promise<boolean> {
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
}
