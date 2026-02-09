import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
import {
  hasSummarizationTag,
  isSummarizationGenerationPass,
} from "./tokens/conversation-state";
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

export class VercelAIChatModelProvider
  implements LanguageModelChatProvider, vscode.Disposable
{
  private context: ExtensionContext;
  private modelsClient: ModelsClient;
  private tokenEstimator: HybridTokenEstimator;
  private configService: ConfigService;
  private enricher: ModelEnricher;
  /** Cache of enriched model data for the session */
  private enrichedModels = new Map<string, EnrichedModelData>();
  private readonly modelInfoChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation =
    this.modelInfoChangeEmitter.event;
  private statusBar: TokenStatusBar | null = null;
  /** Current agent ID for status bar tracking */
  private currentAgentId: string | null = null;
  /** Most recent tool definitions received from VS Code */
  private lastTools: ProvideLanguageModelChatResponseOptions["tools"] | null =
    null;
  /** Pending token debug capture bundle */
  private pendingTokenCapture: {
    dir: string;
    startedAt: string;
    sessionId: string;
  } | null = null;
  /** Track token count bursts to group provideTokenCount calls */
  private tokenCountBatchId = 0;
  private lastTokenCountAt = 0;

  constructor(
    context: ExtensionContext,
    configService: ConfigService = new ConfigService(),
  ) {
    this.context = context;
    this.configService = configService;
    this.modelsClient = new ModelsClient(configService);
    this.tokenEstimator = new HybridTokenEstimator(context, configService);
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
    this.tokenEstimator.dispose();
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
    sequenceEstimate?: number,
    summarizationDetected?: boolean,
    responseMessage?: LanguageModelChatMessage,
    actualOutputTokens?: number,
  ): void {
    this.tokenEstimator.recordActual(
      messages,
      model,
      actualInputTokens,
      sequenceEstimate,
      summarizationDetected,
      responseMessage,
      actualOutputTokens,
    );
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
    // Use hashMessage instead of JSON.stringify to avoid circular reference issues
    // that can occur with VS Code's internal message structures
    const chatHash = createHash("sha256")
      .update(chatMessages.map((m) => hashMessage(m)).join("|"))
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
      this.lastTools = options.tools ?? null;
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
        token,
        options.tools ? { tools: options.tools } : {},
      );
      const estimatedTokens = tokenEstimate.total;
      const estimatedDeltaTokens = tokenEstimate.delta;
      const conversationId = tokenEstimate.conversationId;
      const tokenBreakdown = tokenEstimate.breakdown;
      const maxInputTokens = model.maxInputTokens;
      logger.debug(
        `Token estimate: ${estimatedTokens.toString()}/${String(maxInputTokens)} (${Math.round((estimatedTokens / maxInputTokens) * 100).toString()}%), delta: ${estimatedDeltaTokens?.toString() ?? "n/a"}, conversationId: ${conversationId ?? "n/a"}`,
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
          tokenBreakdown,
          conversationLookup: this.tokenEstimator.getConversationLookupDebug(
            model.family,
            chatMessages,
          ),
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
      const agentTypeHash = computeAgentTypeHash(toolSetHash);
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
      this.currentAgentId = chatId;
      this.statusBar?.startAgent(
        chatId,
        estimatedTokens,
        maxInputTokens,
        model.id,
        systemPromptHash,
        agentTypeHash,
        firstUserMessageHash,
        estimatedDeltaTokens,
        conversationId,
      );

      const apiKey = await this.getApiKey(false);
      if (!apiKey) {
        throw new Error(ERROR_MESSAGES.API_KEY_NOT_FOUND);
      }

      // Lazy enrichment: fetch additional metadata on first use of each model
      if (this.configService.modelsEnrichmentEnabled) {
        await this.enrichModelIfNeeded(model.id, apiKey);
      }

      // Capture sequence estimate BEFORE API call for rolling correction (RFC 047)
      const sequenceEstimate =
        this.tokenEstimator.getCurrentSequence()?.totalEstimate;

      // Detect summarization for logging/forensics
      const summarizationDetected = hasSummarizationTag(chatMessages);
      const isGenerationPass = isSummarizationGenerationPass(chatMessages);

      if (summarizationDetected) {
        logger.info(
          `[TokenState] Summarization detected: <conversation-summary> tag found`,
        );
      }
      if (isGenerationPass) {
        logger.info(
          `[TokenState] Summarization Generation detected: System prompt marker found`,
        );
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
          onUsage: (actualInputTokens, responseMessage, actualOutputTokens) => {
            // Record actual tokens for delta estimation
            this.recordUsage(
              model,
              chatMessages,
              actualInputTokens,
              sequenceEstimate,
              summarizationDetected, // maintained for signature compatibility but used differently
              responseMessage,
              actualOutputTokens,
            );
          },
        },
      );

      if (result.cancelled) {
        responseSent = true;
        logger.debug(`[OpenResponses] Chat request cancelled for ${model.id}`);
        return;
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
      // Don't report abort/cancellation as an error - it's expected behavior
      if (this.isAbortError(error)) {
        logger.debug("Request was cancelled");
        return;
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
        this.statusBar?.errorAgent(this.currentAgentId);
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
      this.finalizeTokenDebugCapture(model.id, chatId, model.maxInputTokens);
      // Clear current request tracking
      this.currentAgentId = null;
      abortSubscription.dispose();
    }
  }

  /**
   * Arm a token debug capture bundle for the next request.
   */
  startTokenDebugCapture(): string | null {
    const dir = path.join(
      os.homedir(),
      ".vscode-ai-gateway",
      "captures",
      `token-debug-${Date.now().toString()}`,
    );
    try {
      fs.mkdirSync(dir, { recursive: true });
      const logPath = path.join(
        os.homedir(),
        ".vscode-ai-gateway",
        "token-count-calls.jsonl",
      );
      fs.writeFileSync(logPath, "");
      this.pendingTokenCapture = {
        dir,
        startedAt: new Date().toISOString(),
        sessionId: vscode.env.sessionId,
      };
      return dir;
    } catch (err) {
      logger.error(`[Token Debug] Failed to start capture: ${String(err)}`);
      return null;
    }
  }

  private finalizeTokenDebugCapture(
    modelId: string,
    chatId: string,
    maxInputTokens: number,
  ): void {
    if (!this.pendingTokenCapture) {
      return;
    }

    const { dir, startedAt, sessionId } = this.pendingTokenCapture;
    this.pendingTokenCapture = null;

    try {
      const logPath = path.join(
        os.homedir(),
        ".vscode-ai-gateway",
        "token-count-calls.jsonl",
      );
      const bundleLogPath = path.join(dir, "token-count-calls.jsonl");
      if (fs.existsSync(logPath)) {
        fs.copyFileSync(logPath, bundleLogPath);
      } else {
        fs.writeFileSync(bundleLogPath, "");
      }

      const toolsPath = path.join(dir, "tools-snapshot.json");
      if (this.lastTools) {
        const payload = {
          capturedAt: new Date().toISOString(),
          toolCount: this.lastTools.length,
          tools: this.lastTools,
        };
        fs.writeFileSync(toolsPath, JSON.stringify(payload, null, 2));
      } else {
        fs.writeFileSync(toolsPath, JSON.stringify({ tools: [] }, null, 2));
      }

      const metaPath = path.join(dir, "bundle-metadata.json");
      fs.writeFileSync(
        metaPath,
        JSON.stringify(
          {
            startedAt,
            completedAt: new Date().toISOString(),
            sessionId,
            chatId,
            modelId,
            maxInputTokens,
          },
          null,
          2,
        ),
      );

      window.showInformationMessage(`Token debug bundle written to ${dir}`);
    } catch (err) {
      logger.error(`[Token Debug] Failed to finalize capture: ${String(err)}`);
    }
  }

  /**
   * Write the most recent tool definitions to a JSON file for analysis.
   */
  dumpLastToolsSnapshot(): string | null {
    if (!this.lastTools) {
      return null;
    }
    const dir = path.join(os.homedir(), ".vscode-ai-gateway");
    const filePath = path.join(
      dir,
      `tools-snapshot-${Date.now().toString()}.json`,
    );
    try {
      fs.mkdirSync(dir, { recursive: true });
      const payload = {
        capturedAt: new Date().toISOString(),
        toolCount: this.lastTools.length,
        tools: this.lastTools,
      };
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
      return filePath;
    } catch (err) {
      logger.error(
        `[Tools Snapshot] Failed to write tool snapshot: ${String(err)}`,
      );
      return null;
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

    // Forensic file logging: write to ~/.vscode-ai-gateway/token-count-calls.jsonl
    try {
      const now = Date.now();
      if (now - this.lastTokenCountAt > 1500) {
        this.tokenCountBatchId += 1;
      }
      this.lastTokenCountAt = now;
      const isString = typeof text === "string";
      const contentLen = isString
        ? text.length
        : Array.from(text.content).reduce(
            (acc, part) =>
              acc +
              ("value" in part && typeof part.value === "string"
                ? part.value.length
                : 0),
            0,
          );
      const entry = {
        ts: new Date().toISOString(),
        batchId: this.tokenCountBatchId,
        sessionId: vscode.env.sessionId,
        chatId: this.currentAgentId,
        model: model.id,
        family: model.family,
        maxInput: model.maxInputTokens,
        estimate,
        chars: contentLen,
        type: isString ? "string" : "message",
        ...(isString
          ? { preview: text.substring(0, 120).replace(/\n/g, "\\n") }
          : {
              role: text.role,
              parts: Array.from(text.content).length,
              preview: Array.from(text.content)
                .map((p) =>
                  "value" in p && typeof p.value === "string"
                    ? p.value.substring(0, 60).replace(/\n/g, "\\n")
                    : `[${Object.keys(p as unknown as Record<string, unknown>).join(",")}]`,
                )
                .join(" | "),
            }),
      };
      const dir = path.join(os.homedir(), ".vscode-ai-gateway");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(dir, "token-count-calls.jsonl"),
        JSON.stringify(entry) + "\n",
      );
    } catch {
      // never let logging break token counting
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
    delta: number | undefined;
    conversationId: string | undefined;
    breakdown: {
      messageTokens: number;
      toolTokens: number;
      systemPromptTokens: number;
      source: string;
      knownTokens: number;
      estimatedTokens: number;
    };
  } {
    void _token;

    // Use conversation-level delta estimation
    // Now passing tools and systemPrompt so the estimator can decide whether to add them
    // (on full estimate) or use the cached total (which includes them).
    const estimateOptions: {
      tools?: readonly {
        name: string;
        description?: string;
        inputSchema?: unknown;
      }[];
      systemPrompt?: string;
    } = {};
    if (options?.tools) {
      estimateOptions.tools = options.tools;
    }
    if (options?.systemPrompt) {
      estimateOptions.systemPrompt = options.systemPrompt;
    }
    const estimate = this.tokenEstimator.estimateConversation(
      messages,
      model,
      estimateOptions,
    );

    const total = estimate.tokens;

    // We still calculate component tokens for logging and breakdown reporting,
    // but we do NOT add them to the total (HybridTokenEstimator handles that consistently now).
    const tokenCounter = this.tokenEstimator.getTokenCounter();
    let toolTokens = 0;
    if (options?.tools && options.tools.length > 0) {
      toolTokens = tokenCounter.countToolsTokens(options.tools, model.family);
      logger.debug(
        `Tool schemas: ${toolTokens.toString()} tokens for ${options.tools.length.toString()} tools`,
      );
    }

    let systemPromptTokens = 0;
    if (options?.systemPrompt) {
      systemPromptTokens = tokenCounter.countSystemPromptTokens(
        options.systemPrompt,
        model.family,
      );
      logger.debug(`System prompt: ${systemPromptTokens.toString()} tokens`);
    }

    // Reconstruct message tokens portion
    // Note: If estimate.source is 'estimated', total = messages + tools + system.
    // If estimate.source is 'exact' or 'delta', total = known(messages+tools+system) [+ est(newMessages)].
    // So distinct messageTokens is roughly total - tools - system.
    const messageTokens = Math.max(0, total - toolTokens - systemPromptTokens);

    const sourceLabel =
      estimate.source === "exact"
        ? "ground truth"
        : estimate.source === "delta"
          ? `delta (${estimate.knownTokens.toString()} known + ${estimate.estimatedTokens.toString()} est)`
          : "full estimate";

    logger.debug(
      `Total input token estimate: ${total.toString()} tokens (${sourceLabel}, ` +
        `${messages.length.toString()} messages, ${estimate.newMessageCount.toString()} new). ` +
        `Breakdown: ~${messageTokens.toString()} msg + ${toolTokens.toString()} tool + ${systemPromptTokens.toString()} sys`,
    );

    // Return both total and delta (estimated tokens for new messages only)
    // Only return delta when we have a known prefix - otherwise it's a full estimate
    const delta =
      estimate.source === "delta" ? estimate.estimatedTokens : undefined;
    return {
      total,
      delta,
      conversationId: estimate.conversationId,
      breakdown: {
        messageTokens,
        toolTokens,
        systemPromptTokens,
        source: estimate.source,
        knownTokens: estimate.knownTokens,
        estimatedTokens: estimate.estimatedTokens,
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
        this.modelInfoChangeEmitter.fire();
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
