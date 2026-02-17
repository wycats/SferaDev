import { createHash, randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { getVercelCliTokenFromStorage } from "./vercel-auth.js";
import {
  authentication,
  type CancellationToken,
  commands,
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

/**
 * VS Code may serialize message content parts as plain objects.
 * This type represents a serialized text part with {text, type} structure.
 */
interface SerializedTextPart {
  readonly type: "text";
  readonly text: string;
}

/**
 * Union of possible text part representations.
 * At runtime, parts may be either LanguageModelTextPart instances or serialized objects.
 */
type TextPartLike = LanguageModelTextPart | SerializedTextPart;

/**
 * Type guard for text-like parts (either LanguageModelTextPart or serialized {type, text}).
 */
function isTextPart(part: unknown): part is TextPartLike {
  if (part instanceof LanguageModelTextPart) return true;
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === "text" &&
    "text" in part &&
    typeof (part as SerializedTextPart).text === "string"
  );
}

/**
 * Extract text value from a text-like part.
 */
function getTextValue(part: TextPartLike): string {
  if (part instanceof LanguageModelTextPart) {
    return part.value;
  }
  return part.text;
}

import { VERCEL_AI_AUTH_PROVIDER_ID } from "./auth";
import { ConfigService } from "./config";
import {
  ERROR_MESSAGES,
  EXTENSION_ID,
  LAST_SELECTED_MODEL_KEY,
} from "./constants";
import {
  extractErrorMessage,
  extractTokenCountFromError,
  logError,
  logger,
} from "./logger";
import { ModelsClient } from "./models";
import { type EnrichedModelData, ModelEnricher } from "./models/enrichment";
import {
  executeOpenResponsesChat,
  detectSummarizationRequest,
} from "./provider/openresponses-chat.js";
import { extractSystemPrompt } from "./provider/system-prompt.js";
import {
  computeAgentTypeHash,
  computeToolSetHash,
  hashUserMessage,
} from "./identity";
import { findLatestStatefulMarker } from "./utils/stateful-marker.js";
import type { AgentRegistry } from "./agent/index.js";
import type { TokenStatusBar } from "./status-bar";
import type { ConversationManager } from "./conversation/index.js";
import { TokenCounter } from "./tokens/counter";
import { getTurnCharacterizer } from "./turn-characterizer.js";

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

export class VercelAIChatModelProvider
  implements LanguageModelChatProvider, vscode.Disposable
{
  private context: ExtensionContext;
  private modelsClient: ModelsClient;
  private tokenCounter: TokenCounter;
  private configService: ConfigService;
  private enricher: ModelEnricher;
  /** Cache of enriched model data for the session */
  private enrichedModels = new Map<string, EnrichedModelData>();
  private readonly modelInfoChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation =
    this.modelInfoChangeEmitter.event;
  private statusBar: TokenStatusBar | null = null;
  private agentRegistry: AgentRegistry | null = null;
  /** Conversation manager for turn characterization updates */
  private conversationManager: ConversationManager | null = null;
  /** Current agent ID for status bar tracking */
  private currentAgentId: string | null = null;

  constructor(
    context: ExtensionContext,
    configService: ConfigService = new ConfigService(),
  ) {
    this.context = context;
    this.configService = configService;
    this.modelsClient = new ModelsClient(configService);
    // Wire last-selected model as fallback default (decoded from workspaceState)
    this.modelsClient.setLastSelectedModelGetter(() =>
      this.getLastSelectedModelId(),
    );
    this.tokenCounter = new TokenCounter();
    void this.tokenCounter.initialize();
    this.enricher = new ModelEnricher(configService);
    // Initialize enricher persistence for faster startup
    this.enricher.initializePersistence(context.globalState);
    // Initialize models client persistence for instant model availability on reload
    // The callback fires when models are updated in the background, triggering VS Code refresh
    this.modelsClient.initializePersistence(context.globalState, () => {
      this.modelInfoChangeEmitter.fire();
    });
  }

  dispose(): void {
    this.modelInfoChangeEmitter.dispose();
  }

  /**
   * Set the status bar instance for token usage display.
   * Called from extension.ts after both provider and status bar are created.
   */
  setStatusBar(statusBar: TokenStatusBar): void {
    this.statusBar = statusBar;
  }

  /**
   * Set the agent registry for lifecycle tracking.
   */
  setAgentRegistry(registry: AgentRegistry): void {
    this.agentRegistry = registry;
  }

  /**
   * Set the conversation manager for turn characterization.
   * Called from extension.ts after tree view is created.
   */
  setConversationManager(manager: ConversationManager): void {
    this.conversationManager = manager;
  }

  /**
   * Invalidate the model cache and trigger VS Code to re-resolve models.
   * Called by the "Refresh Models" command.
   */
  refreshModels(): void {
    this.modelsClient.invalidateCache();
    this.modelInfoChangeEmitter.fire();
    logger.info("Model refresh triggered by user command");
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

      return cachedModels;
    }

    const apiKey = await this.getApiKey(options.silent);
    if (!apiKey) {
      // Auth temporarily unavailable - return cached models to prevent picker flicker
      if (cachedModels.length > 0) {
        logger.debug(
          `No API key available, returning ${cachedModels.length.toString()} cached models`,
        );
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
      return models;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(ERROR_MESSAGES.MODELS_FETCH_FAILED, { error: errorMessage });
      // Fall back to cached models to prevent the model picker from switching
      // to a Copilot default. VS Code persists the fallback selection, so
      // returning empty even once causes a sticky regression.
      if (cachedModels.length > 0) {
        logger.debug(
          `Returning ${cachedModels.length.toString()} cached models after fetch error`,
        );
        return cachedModels;
      }
      // No cached models available — notify user so they know why the picker is empty
      void window.showWarningMessage(ERROR_MESSAGES.MODELS_UNAVAILABLE);
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
    // Use hashMessage instead of JSON.stringify to avoid circular reference issues
    // that can occur with VS Code's internal message structures
    const chatHash = createHash("sha256")
      .update(chatMessages.map((m) => hashMessage(m)).join("|"))
      .digest("hex")
      .substring(0, 8);
    const chatId = `chat-${chatHash}-${Date.now().toString()}`;

    // Derive stable conversation identity from stateful marker (GCMP pattern)
    // If a marker exists in previous assistant messages, reuse its sessionId.
    // Otherwise, generate a new UUID for this conversation.
    const statefulMarker = findLatestStatefulMarker(chatMessages, model.id);
    const conversationId = statefulMarker?.sessionId ?? randomUUID();

    // Log session ID at entry point to identify which window handles each request
    const vsCodeSessionId = vscode.env.sessionId.substring(0, 8);
    logger.info(
      `[${vsCodeSessionId}] Chat request to ${model.id} with ${chatMessages.length.toString()} messages`,
    );
    logger.debug(
      `[${vsCodeSessionId}] Chat ID: ${chatId}, conversationId: ${conversationId}`,
    );

    // Mark this model as user-enabled (sticky selection).
    // This ensures the model has isUserSelectable: true and won't be reset
    // when VS Code's onDidChangeLanguageModels fires from other vendors.
    const wasNewlyEnabled = this.modelsClient.enableModel(model.id);
    if (wasNewlyEnabled) {
      // Fire model change event so VS Code picks up the updated isUserSelectable
      this.modelInfoChangeEmitter.fire();
    }

    const abortController = new AbortController();
    const abortSubscription = token.onCancellationRequested(() => {
      abortController.abort();
    });

    let responseSent = false;

    try {
      // Extract system prompt for diagnostics logging
      // NOTE: systemPromptHash is for diagnostics ONLY - not used for identity
      const systemPrompt = extractSystemPrompt(chatMessages);
      const systemPromptHash = systemPrompt
        ? createHash("sha256")
            .update(systemPrompt)
            .digest("hex")
            .substring(0, 16)
        : undefined;

      // Pre-flight check: estimate total tokens and validate against model limit
      // Now includes tool schemas (can be 50k+ tokens)
      const tokenEstimate = this.estimateTotalInputTokens(
        model,
        chatMessages,
        options.tools ? { tools: options.tools } : {},
      );
      const estimatedTokens = tokenEstimate.total;
      const maxInputTokens = model.maxInputTokens;
      logger.debug(
        `Token estimate: ${estimatedTokens.toString()}/${String(maxInputTokens)} (${Math.round((estimatedTokens / maxInputTokens) * 100).toString()}%)`,
      );

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
      const agentTypeHash = computeAgentTypeHash(toolSetHash);
      // Find the first user message
      const firstUserMessage = chatMessages.find(
        (m) => m.role === LanguageModelChatMessageRole.User,
      );
      const firstUserMessageText = firstUserMessage
        ? (
            Array.from(firstUserMessage.content).filter(
              isTextPart,
            ) as TextPartLike[]
          )
            .map(getTextValue)
            .join("")
        : undefined;
      const firstUserMessageHash = firstUserMessageText
        ? hashUserMessage(firstUserMessageText)
        : undefined;
      // DEBUG: Dump full user message to see what VS Code sends
      if (firstUserMessageText) {
        logger.info(
          `[DEBUG] Full firstUserMessageText (${firstUserMessageText.length} chars):\n${firstUserMessageText.slice(0, 2000)}${firstUserMessageText.length > 2000 ? "\n... (truncated)" : ""}`,
        );
      }
      // Extract a preview of the first user message for display
      // Strip leading XML tags to get to the actual user content for the preview
      let previewText = firstUserMessageText;
      if (previewText) {
        // Remove leading XML-like blocks (e.g., <environment_info>...</environment_info>)
        previewText = previewText.replace(/^<[^>]+>[\s\S]*?<\/[^>]+>\s*/g, "");
        // Also remove standalone opening tags at the start
        previewText = previewText.replace(/^<[^>]+>\s*/g, "");
        // Trim whitespace
        previewText = previewText.trim();
      }
      // If after stripping XML we have meaningful content, use it
      // Otherwise fall back to the raw text (will be handled by title generator)
      const firstUserMessagePreview =
        previewText && previewText.length > 10
          ? previewText.slice(0, 50).trim() +
            (previewText.length > 50 ? "..." : "")
          : firstUserMessageText
            ? firstUserMessageText.slice(0, 50).trim() +
              (firstUserMessageText.length > 50 ? "..." : "")
            : undefined;
      const isSummarizationRequest = detectSummarizationRequest(chatMessages);
      // Compute delta token estimate for resumed conversations.
      // Instead of showing the full re-estimate during streaming (which has
      // systematic error from tool schema multipliers etc.), we estimate only
      // the NEW messages and add that to the last actual from the API.
      // This keeps the display anchored to the accurate API count.
      let estimatedDeltaTokens: number | undefined;
      const prevContext = this.agentRegistry?.getAgentContext(conversationId);
      if (prevContext) {
        // Fork detection: if message count decreased, user edited a message
        if (chatMessages.length < prevContext.lastMessageCount) {
          const forkPoint = chatMessages.length;
          logger.info(
            `[ForkDetection] Fork detected in conversation ${conversationId.slice(0, 8)}: ` +
              `${prevContext.lastMessageCount} → ${chatMessages.length} messages (fork at ${forkPoint})`,
          );

          this.conversationManager?.handleFork(
            conversationId,
            forkPoint,
            prevContext.lastMessageCount,
            chatMessages.length,
            chatId,
          );
        }

        const newMessages = chatMessages.slice(prevContext.lastMessageCount);
        let deltaTokens = 0;
        for (const msg of newMessages) {
          deltaTokens += this.tokenCounter.estimateMessageTokens(
            msg,
            model.family,
          );
        }
        estimatedDeltaTokens = deltaTokens;
        logger.debug(
          `[TokenDelta] Resumed conversation: lastActual=${prevContext.lastActualInputTokens}, ` +
            `newMessages=${newMessages.length}/${chatMessages.length}, ` +
            `estimatedDelta=${deltaTokens}, ` +
            `fullEstimate=${estimatedTokens}`,
        );
      }

      this.currentAgentId = chatId;
      this.agentRegistry?.startAgent({
        agentId: chatId,
        chatId,
        estimatedTokens,
        maxTokens: maxInputTokens,
        modelId: model.id,
        ...(systemPromptHash !== undefined ? { systemPromptHash } : {}),
        agentTypeHash,
        ...(firstUserMessageHash !== undefined ? { firstUserMessageHash } : {}),
        ...(estimatedDeltaTokens !== undefined ? { estimatedDeltaTokens } : {}),
        conversationId,
        isSummarization: isSummarizationRequest,
        ...(firstUserMessagePreview !== undefined
          ? { firstUserMessagePreview }
          : {}),
      });

      const apiKey = await this.getApiKey(false);
      if (!apiKey) {
        void window
          .showErrorMessage(
            ERROR_MESSAGES.AUTH_KEY_MISSING,
            "Manage Authentication",
          )
          .then((selection) => {
            if (selection === "Manage Authentication") {
              void commands.executeCommand(`${EXTENSION_ID}.manage`);
            }
          });
        throw new Error(ERROR_MESSAGES.AUTH_KEY_MISSING);
      }

      // Lazy enrichment: fetch additional metadata on first use of each model
      await this.enrichModelIfNeeded(model.id, apiKey);

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
          agentRegistry: this.agentRegistry,
          apiKey,
          estimatedInputTokens: estimatedTokens,
          chatId,
          conversationId,
          globalStorageUri: this.context.globalStorageUri,
          onTurnComplete: (info) => {
            void this.handleTurnComplete(
              info.conversationId,
              info.text,
              info.turnNumber,
              info.isToolContinuation,
              info.userMessagePreview,
              info.toolsUsed,
            );
          },
        },
      );

      if (result.cancelled) {
        responseSent = true;
        logger.debug(`[OpenResponses] Chat request cancelled for ${model.id}`);
        throw new vscode.CancellationError();
      }

      // Track if we sent a response (for error handling)
      responseSent = result.success;

      // Update last selected model on success
      if (result.success) {
        await this.context.workspaceState.update(
          LAST_SELECTED_MODEL_KEY,
          model.id,
        );
        logger.info(`[OpenResponses] Chat request completed for ${model.id}`);
      }
    } catch (error) {
      // Propagate cancellation errors to VS Code (GCMP pattern)
      if (
        error instanceof vscode.CancellationError ||
        this.isAbortError(error)
      ) {
        logger.debug("Request was cancelled");
        throw new vscode.CancellationError();
      }

      logError("Exception during streaming", error);
      const errorMessage = extractErrorMessage(error);

      // Extract token info for status bar display (if this is a "too long" error)
      const tokenInfo = extractTokenCountFromError(error);
      if (tokenInfo) {
        // Show error in status bar with token info
        this.statusBar?.showError(
          `Token limit exceeded: ${tokenInfo.actualTokens.toLocaleString()} tokens ` +
            `(max: ${tokenInfo.maxTokens?.toLocaleString() ?? "unknown"})`,
        );
      }

      // Mark agent as errored in status bar
      // This ensures agents don't get stuck in 'streaming' state on any error
      if (this.currentAgentId) {
        this.agentRegistry?.errorAgent(this.currentAgentId);
      }

      // CRITICAL: Always emit an error response to prevent "no response returned" error.
      // If nothing has been sent yet, this is the only response VS Code will see.
      if (!responseSent) {
        logger.error(
          `Emitting error response for chat ${chatId} due to: ${errorMessage}`,
        );
        progress.report(
          new LanguageModelTextPart(`\n\n**Error:** ${errorMessage}\n\n`),
        );
      }
    } finally {
      // Clear current request tracking
      this.currentAgentId = null;
      abortSubscription.dispose();
    }
  }

  /**
   * Handle turn completion by generating a characterization label.
   * Fire-and-forget — errors are logged but don't affect the user.
   */
  private async handleTurnComplete(
    conversationId: string,
    text: string,
    turnNumber: number,
    isToolContinuation: boolean,
    userMessagePreview: string | undefined,
    toolsUsed: string[],
  ): Promise<void> {
    try {
      if (!this.conversationManager) {
        return;
      }

      // Mark tool continuations in the activity log
      if (isToolContinuation) {
        this.conversationManager.markToolContinuation(
          conversationId,
          turnNumber,
        );
      }

      // Update user message preview if available
      if (userMessagePreview) {
        this.conversationManager.setUserMessagePreview(
          conversationId,
          turnNumber,
          userMessagePreview,
        );
      }

      // Update tools used on the AI response
      if (toolsUsed.length > 0) {
        this.conversationManager.setToolsUsed(
          conversationId,
          turnNumber,
          toolsUsed,
        );
      }

      const characterizer = getTurnCharacterizer();
      const characterization = await characterizer.characterize(text);
      if (characterization) {
        this.conversationManager.updateTurnCharacterization(
          conversationId,
          turnNumber,
          characterization,
        );
      }
    } catch (error) {
      logger.debug(
        `[Provider] Turn characterization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
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
   * Estimate token count for a single message or string.
   *
   * Called by VS Code before sending messages to decide whether to
   * compact/truncate. Uses ai-tokenizer for direct encoding-based counting.
   */
  provideTokenCount(
    model: LanguageModelChatInformation,
    text: string | LanguageModelChatMessage,
    _token: CancellationToken,
  ): Promise<number> {
    void _token;

    const estimate =
      typeof text === "string"
        ? this.tokenCounter.estimateTextTokens(text, model.family)
        : this.tokenCounter.estimateMessageTokens(text, model.family);

    return Promise.resolve(estimate);
  }

  /**
   * Estimate total input tokens for all messages.
   * Used for pre-flight validation before sending to the API.
   *
   * Sums:
   * - Per-message token estimates (ai-tokenizer encoding)
   * - Tool schema tokens (16 + 8/tool + content × 1.1)
   * - System prompt tokens (content + 28 overhead)
   */
  private estimateTotalInputTokens(
    model: LanguageModelChatInformation,
    messages: readonly LanguageModelChatMessage[],
    options?: {
      tools?: readonly {
        name: string;
        description?: string;
        inputSchema?: unknown;
      }[];
      systemPrompt?: string;
    },
  ): {
    total: number;
    breakdown: {
      messageTokens: number;
      toolTokens: number;
      systemPromptTokens: number;
      source: string;
      knownTokens: number;
      estimatedTokens: number;
    };
  } {
    let messageTokens = 0;
    for (const msg of messages) {
      messageTokens += this.tokenCounter.estimateMessageTokens(
        msg,
        model.family,
      );
    }

    let toolTokens = 0;
    if (options?.tools && options.tools.length > 0) {
      toolTokens = this.tokenCounter.countToolsTokens(
        options.tools,
        model.family,
      );
      logger.debug(
        `Tool schemas: ${toolTokens.toString()} tokens for ${options.tools.length.toString()} tools`,
      );
    }

    let systemPromptTokens = 0;
    if (options?.systemPrompt) {
      systemPromptTokens = this.tokenCounter.countSystemPromptTokens(
        options.systemPrompt,
        model.family,
      );
      logger.debug(`System prompt: ${systemPromptTokens.toString()} tokens`);
    }

    const total = messageTokens + toolTokens + systemPromptTokens;

    logger.debug(
      `Total input token estimate: ${total.toString()} tokens (full estimate, ` +
        `${messages.length.toString()} messages). ` +
        `Breakdown: ~${messageTokens.toString()} msg + ${toolTokens.toString()} tool + ${systemPromptTokens.toString()} sys`,
    );

    return {
      total,
      breakdown: {
        messageTokens,
        toolTokens,
        systemPromptTokens,
        source: "estimate",
        knownTokens: 0,
        estimatedTokens: total,
      },
    };
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
      if (session?.accessToken) {
        return session.accessToken;
      }

      // Fallback for first-run/clean profiles: user may already be authenticated
      // with Vercel CLI, but no VS Code auth session exists yet for our provider.
      const cliToken = getVercelCliTokenFromStorage();
      if (cliToken) {
        logger.debug("Using Vercel CLI token fallback");
        return cliToken;
      }

      return undefined;
    } catch (error) {
      if (!silent) {
        logger.error("Failed to get authentication session:", error);
        void window
          .showErrorMessage(ERROR_MESSAGES.AUTH_FAILED, "Manage Authentication")
          .then((selection) => {
            if (selection === "Manage Authentication") {
              void commands.executeCommand(`${EXTENSION_ID}.manage`);
            }
          });
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
}
