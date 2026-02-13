/**
 * OpenResponses Chat Implementation
 *
 * Provides the chat implementation using the OpenResponses API directly,
 * bypassing the Vercel AI SDK for more accurate token usage reporting.
 *
 * This implementation:
 * - Uses the openresponses-client package for HTTP/SSE streaming
 * - Handles ALL 24 streaming event types with high fidelity
 * - Reports accurate token usage from the API response
 * - Maintains compatibility with the existing provider interface
 */

import {
  type CreateResponseBody,
  createClient,
  OpenResponsesError,
  type Usage,
} from "openresponses-client";
import * as vscode from "vscode";
import {
  type CancellationToken,
  type LanguageModelChatInformation,
  type LanguageModelChatMessage,
  type LanguageModelResponsePart,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  type Progress,
  type ProvideLanguageModelChatResponseOptions,
  type Uri,
} from "vscode";
import type { ConfigService } from "../config.js";
import { ERROR_MESSAGES, EXTENSION_ID } from "../constants.js";
import { treeDiagnostics } from "../diagnostics/tree-diagnostics.js";
import {
  extractTokenCountFromError,
  type ExtractedTokenInfo,
  logger,
} from "../logger.js";
import {
  ErrorCaptureLogger,
  type ErrorCaptureData,
} from "../logger/error-capture.js";
import type { TokenStatusBar } from "../status-bar.js";
import { extractTokenInfoFromDetails } from "./error-extraction.js";
import { translateRequest } from "./request-builder.js";
import { type AdaptedEvent, StreamAdapter } from "./stream-adapter.js";
import { InvestigationLogger } from "../logger/investigation.js";
import { findLatestStatefulMarker } from "../utils/stateful-marker.js";
import { decodeVsCodeModelId } from "../models/vscode-model-id";

/** Diagnostic state captured when stream completes with no content parts. */
interface NoResponseDiagnostic {
  chatId: string;
  conversationId: string;
  model: string;
  isSummarization: boolean;
  eventCount: number;
  textPartCount: number;
  toolCallCount: number;
  eventTypeCounts: Record<string, number>;
  accumulatedTextLength: number;
  responseId: string | undefined;
  finishReason: string | undefined;
  streamError: string | undefined;
  streamCancelled: boolean | undefined;
  timeToFirstTokenMs: number | null;
  totalDurationMs: number;
  resultState: string;
}

/**
 * Options for the OpenResponses chat implementation
 */
export interface OpenResponsesChatOptions {
  /** Configuration service for settings */
  configService: ConfigService;
  /** Status bar for token display */
  statusBar: TokenStatusBar | null;
  /** API key for authentication */
  apiKey: string;
  /** Estimated input tokens (for status bar) */
  estimatedInputTokens: number;
  /** Chat ID for logging/tracking */
  chatId: string;
  /** Stable conversation identity (from stateful marker sessionId or new UUID) */
  conversationId: string;
  /** Global storage location for persistent logs */
  globalStorageUri: Uri;
}

/**
 * Result of the OpenResponses chat implementation
 */
export interface OpenResponsesChatResult {
  /** Usage data from the API response */
  usage?: Usage;
  /** Whether the response completed successfully */
  success: boolean;
  /** Error message if the response failed */
  error?: string;
  /** Whether the response was cancelled */
  cancelled?: boolean;
  /** Response ID from the API */
  responseId?: string;
  /** Finish reason from the API */
  finishReason?: AdaptedEvent["finishReason"];
  /** Token info extracted from "input too long" errors */
  tokenInfo?: ExtractedTokenInfo;
}

/**
 * Execute a chat request using the OpenResponses API.
 *
 * This function handles the full lifecycle:
 * 1. Translate VS Code messages to OpenResponses format
 * 2. Stream the response via SSE
 * 3. Adapt events to VS Code parts
 * 4. Report token usage
 */
export async function executeOpenResponsesChat(
  model: LanguageModelChatInformation,
  chatMessages: readonly LanguageModelChatMessage[],
  options: ProvideLanguageModelChatResponseOptions,
  progress: Progress<LanguageModelResponsePart>,
  token: CancellationToken,
  chatOptions: OpenResponsesChatOptions,
): Promise<OpenResponsesChatResult> {
  const {
    configService,
    statusBar,
    apiKey,
    estimatedInputTokens,
    chatId,
    conversationId,
    globalStorageUri,
  } = chatOptions;

  const errorCaptureLogger = new ErrorCaptureLogger(globalStorageUri);

  // TRACE: Log raw VS Code messages with actual role values
  const roleNames: Record<number, string> = {
    1: "User",
    2: "Assistant",
    3: "System",
  };
  logger.trace(
    `[OpenResponses] Received ${chatMessages.length} messages: ${chatMessages.map((m) => roleNames[m.role as number] ?? `Unknown(${m.role})`).join(", ")}`,
  );
  logger.debug(
    `[OpenResponses] Estimated input tokens: ${estimatedInputTokens.toString()}`,
  );

  const messageRoles = chatMessages
    .map((m) => roleNames[m.role as number] ?? `Unknown(${m.role})`)
    .join(",");

  // Create client with trace logging
  const client = createClient({
    baseUrl: configService.openResponsesBaseUrl,
    apiKey,
    timeout: configService.timeout,
    log: (level, message, data) => {
      let formatted = message;
      if (data !== undefined) {
        try {
          formatted = `${message}: ${JSON.stringify(data, null, 2)}`;
        } catch {
          formatted = `${message}: [unserializable data]`;
        }
      }
      const logFn = logger[level as keyof typeof logger];
      if (typeof logFn === "function") {
        (logFn as (msg: string) => void)(formatted);
      }
    },
  });

  const adapter = new StreamAdapter(chatOptions.conversationId);

  // Set up abort handling
  const abortController = new AbortController();
  const abortSubscription = token.onCancellationRequested(() => {
    abortController.abort();
  });

  // Note: startAgent is called in provider.ts with identity hashes
  // Do not call it here to avoid overwriting the agent entry

  let responseSent = false;
  let result: OpenResponsesChatResult = { success: false };
  let agentCompleted = false;

  const markAgentComplete = (usage?: Usage) => {
    if (agentCompleted) return;
    agentCompleted = true;
    if (!statusBar) return;

    if (usage) {
      statusBar.completeAgent(chatId, {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        maxInputTokens: model.maxInputTokens,
        modelId: model.id,
        messageCount: chatMessages.length,
      });
      return;
    }

    // Missing usage data is unexpected - log as error but don't crash
    logger.error(
      `[OpenResponses] Stream completed without usage data for chat ${chatId}. Using estimated tokens as fallback.`,
    );

    statusBar.completeAgent(chatId, {
      inputTokens: Math.max(estimatedInputTokens, 0),
      outputTokens: 0,
      maxInputTokens: model.maxInputTokens,
      modelId: model.id,
      messageCount: chatMessages.length,
    });
  };

  const markAgentError = () => {
    if (agentCompleted) return;
    agentCompleted = true;
    statusBar?.errorAgent(chatId);
  };

  const markAgentCancelled = () => {
    if (agentCompleted) return;
    agentCompleted = true;
    statusBar?.completeAgent(chatId, {
      inputTokens: Math.max(estimatedInputTokens, 0),
      outputTokens: 0,
      maxInputTokens: model.maxInputTokens,
      modelId: model.id,
      messageCount: chatMessages.length,
    });
  };

  // Streaming inactivity timeout state — declared before try/catch
  // so they're accessible in catch and finally blocks
  const STREAM_INACTIVITY_TIMEOUT_MS = 120_000; // 2 minutes between events
  let streamTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  let eventCount = 0;

  // Summarization detection + timing (Experiment 2)
  // Declared before try so they're accessible in catch for timeout logging
  const isSummarizationRequest = detectSummarizationRequest(chatMessages);
  const requestStartTime = performance.now();
  let timeToFirstToken: number | null = null;

  const resetStreamTimeout = () => {
    if (streamTimeoutId !== null) {
      clearTimeout(streamTimeoutId);
    }
    streamTimeoutId = setTimeout(() => {
      timedOut = true;
      logger.warn(
        `[OpenResponses] Stream inactivity timeout (${(STREAM_INACTIVITY_TIMEOUT_MS / 1000).toString()}s) — aborting request for ${model.id}`,
      );
      abortController.abort();
    }, STREAM_INACTIVITY_TIMEOUT_MS);
  };

  // Investigation logging handle — declared here so it's accessible in catch
  // eslint-disable-next-line prefer-const
  let investigationHandle: Awaited<
    ReturnType<InvestigationLogger["startRequest"]>
  > | null = null;
  // Counters — declared here so they're accessible in catch for investigation logging
  let toolCallCount = 0;
  let textPartCount = 0;
  let toolsForCapture: unknown[] = [];
  let toolNames: string[] = [];
  let requestBody: (CreateResponseBody & { caching?: "auto" }) | undefined;

  const buildErrorCaptureData = (
    errorType: ErrorCaptureData["errorType"],
    errorMessage: string,
  ): ErrorCaptureData => {
    const usage = result.usage
      ? {
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          cache_read_input_tokens:
            result.usage.input_tokens_details?.cached_tokens,
          output_tokens_details: result.usage.output_tokens_details,
        }
      : null;
    const requestBodyData = requestBody
      ? {
          model: requestBody.model ?? decodeVsCodeModelId(model.id),
          input: (Array.isArray(requestBody.input)
            ? requestBody.input
            : []) as unknown[],
          instructions: requestBody.instructions,
          tools: requestBody.tools as unknown[] | undefined,
          tool_choice: requestBody.tool_choice,
          temperature: requestBody.temperature ?? undefined,
          max_output_tokens: requestBody.max_output_tokens ?? undefined,
          prompt_cache_key: requestBody.prompt_cache_key ?? undefined,
          caching: requestBody.caching ?? undefined,
        }
      : {
          model: decodeVsCodeModelId(model.id),
          input: [] as unknown[],
          instructions: undefined,
          tools: undefined,
          tool_choice: undefined,
          temperature: undefined,
          max_output_tokens: undefined,
          prompt_cache_key: undefined,
          caching: undefined,
        };

    return {
      chatId,
      conversationId,
      errorType,
      errorMessage,
      model: model.id,
      estimatedInputTokens,
      messageCount: chatMessages.length,
      messageRoles,
      toolCount: toolsForCapture.length,
      toolNames,
      isSummarization: isSummarizationRequest,
      requestBody: requestBodyData,
      eventCount,
      textPartCount,
      toolCallCount,
      responseId: adapter.getResponseId(),
      finishReason: result.finishReason,
      usage,
      requestStartMs: requestStartTime,
      ttftMs: timeToFirstToken,
      durationMs: performance.now() - requestStartTime,
    };
  };

  try {
    // Translate messages to OpenResponses format
    const { input, instructions, tools, toolChoice } = translateRequest(
      chatMessages,
      options,
      configService,
    );

    // Log what modelOptions we receive from VS Code
    logger.debug(
      `[OpenResponses] Received modelOptions: ${JSON.stringify(options.modelOptions ?? {})}`,
    );

    // Build the request body
    // Use GCMP's settings: temperature=0.1 (near-deterministic), top_p=1
    // temperature=0 (fully deterministic) was causing tool call issues
    // See: .reference/GCMP configManager.ts uses 0.1 default
    // max_output_tokens: Use model's full capacity (GCMP approach) - don't artificially limit
    // caching: "auto" enables server-side prompt caching (Anthropic cache_control injection)
    // Not yet in generated OpenAPI types — accepted by gateway, see .reference/ai-gateway
    requestBody = {
      model: decodeVsCodeModelId(model.id),
      input,
      stream: true,
      temperature: 0.1,
      top_p: 1,
      caching: "auto",
      max_output_tokens:
        (options.modelOptions?.["maxOutputTokens"] as number | undefined) ??
        model.maxOutputTokens,
    };

    // Use prompt_cache_key (NOT previous_response_id) for session continuity.
    //
    // The Vercel AI Gateway does NOT implement persistence for OpenResponses —
    // it forwards previous_response_id to the upstream provider as a passthrough
    // (see .reference/ai-gateway convert-to-aisdk-call-options.ts). This means:
    //
    // - With BYOK (store=true): OpenAI honors it and loads server-side history.
    //   Since VS Code always sends the full message history as input, this
    //   doubles the context — causing >100% token usage and summarization hangs.
    // - Without BYOK (store=false): OpenAI ignores it entirely — it's a no-op.
    //
    // Either way, previous_response_id is wrong here. VS Code owns the message
    // history and always sends it in full.
    //
    // prompt_cache_key enables server-side prompt prefix caching (KV cache reuse)
    // without loading previous conversation state. This matches GCMP's approach
    // for non-Doubao models (see .reference/GCMP openaiResponsesHandler.ts).
    const statefulMarker = findLatestStatefulMarker(chatMessages, model.id);
    const sessionId = statefulMarker?.sessionId ?? conversationId;
    requestBody.prompt_cache_key = sessionId;
    logger.debug(
      `[OpenResponses] Using prompt_cache_key=${sessionId} for session continuity`,
    );

    if (instructions) {
      requestBody.instructions = instructions;
    }

    if (isSummarizationRequest) {
      // CRITICAL FIX: Strip tools from summarization requests.
      // VS Code Copilot sends all tools (71+) even for summarization with
      // tool_choice="auto". The model sometimes produces a tool call (~38 tokens)
      // instead of a text summary. Copilot treats this as the "summary" (useless),
      // the conversation grows, and another summarization triggers — creating a
      // loop that repeats 2-4 times until one attempt finally produces text.
      // Evidence: .logs/summ-debug shows textPartCount=0, toolCallCount=1 for
      // every failed 38-token summarization attempt.
      logger.warn(
        `[OpenResponses] SUMMARIZATION REQUEST DETECTED for ${model.id}. ` +
          `Messages: ${chatMessages.length}, EstTokens: ${estimatedInputTokens.toString()}, ` +
          `Tools: ${tools.length} (stripped), Chat: ${chatId}`,
      );
    } else if (tools.length > 0) {
      requestBody.tools = tools;
      requestBody.tool_choice = toolChoice;
    }

    logger.debug(`[OpenResponses] Starting streaming request to ${model.id}`);

    // DEBUG: Log the full request body for troubleshooting
    logger.debug(
      `[OpenResponses] Full request body: ${JSON.stringify(requestBody, null, 2)}`,
    );

    // TRACE: Log input summary
    logger.trace(
      `[OpenResponses] Request: ${input.length} input items, ${tools.length} tools`,
    );

    // Investigation logging — start a request handle (null when detail=off)
    const investigationLogger = new InvestigationLogger();
    toolsForCapture = tools as unknown[];
    toolNames = tools.map((t) => (t as { name?: string }).name ?? "unknown");
    investigationHandle = investigationLogger.startRequest({
      conversationId,
      chatId,
      model: model.id,
      estimatedInputTokens,
      messageCount: chatMessages.length,
      messageRoles,
      toolCount: tools.length,
      toolNames,
      isSummarization: isSummarizationRequest,
      requestBody: {
        model: model.id,
        input,
        instructions: requestBody.instructions ?? null,
        tools: requestBody.tools as unknown[] | undefined,
        tool_choice: requestBody.tool_choice,
        temperature: requestBody.temperature ?? undefined,
        max_output_tokens: requestBody.max_output_tokens ?? undefined,
        prompt_cache_key: requestBody.prompt_cache_key,
        caching: requestBody.caching,
      },
    });

    // Stream the response with inactivity timeout.
    // This prevents hangs during large-context requests like summarization,
    // where the model processes 130k+ tokens and takes minutes to respond.
    // The timeout resets on each SSE event, so active streams are unaffected.

    // Start the inactivity timer before entering the stream loop
    resetStreamTimeout();

    let functionCallArgsEventsReceived = 0;
    let firstContentTime: number | null = null;
    const eventTypeCounts = new Map<string, number>();
    // Accumulate all text output for debugging suspicious requests
    let accumulatedText = "";
    for await (const event of client.createStreamingResponse(
      requestBody,
      abortController.signal,
    )) {
      // Reset inactivity timeout on each event
      resetStreamTimeout();
      eventCount++;
      const eventType = (event as { type?: string }).type ?? "unknown";
      eventTypeCounts.set(eventType, (eventTypeCounts.get(eventType) ?? 0) + 1);

      // Record SSE event for investigation logging (before adaptation)
      investigationHandle?.recorder?.recordEvent(eventCount, eventType, event);

      // Update agent activity timestamp for subagent selection
      statusBar?.updateAgentActivity(chatId);

      // Track function_call_arguments events - these indicate actual tool calls
      if (eventType.includes("function_call_arguments")) {
        functionCallArgsEventsReceived++;
        logger.debug(
          `[OpenResponses] Function call args event #${functionCallArgsEventsReceived}: ${eventType}`,
        );
      }

      if (eventCount <= 25) {
        logger.trace(
          `[OpenResponses] Stream event #${eventCount}: ${eventType}`,
        );
      }

      if (eventType === "response.completed") {
        const response = (
          event as { response: { id: string; output?: unknown } }
        ).response;
        const outputLen = Array.isArray(response.output)
          ? response.output.length
          : "n/a";
        logger.debug(
          `[OpenResponses] response.completed (id=${response.id}, outputLen=${outputLen})`,
        );
      }

      const adapted = adapter.adapt(event);

      // Report all parts to VS Code
      for (const part of adapted.parts) {
        // Log part types to diagnose tool call handling
        if (part instanceof LanguageModelToolCallPart) {
          toolCallCount++;
          logger.info(
            `[OpenResponses] Emitting tool call #${toolCallCount}: ${part.name} (callId: ${part.callId})`,
          );
          // Detect runSubagent tool calls for claim creation (RFC 00033)
          if (part.name === "runSubagent" || part.name === "run_subagent") {
            const args = part.input as
              | { agentName?: string; mode?: string }
              | undefined;
            const expectedChildName =
              args?.agentName ?? args?.mode ?? "unknown";

            // Log raw tool call payload to tree diagnostics for debugging claim matching
            treeDiagnostics.log(
              "TOOL_CALL_DETECTED",
              {
                toolName: part.name,
                callId: part.callId,
                extractedName: expectedChildName,
                rawArgs: part.input,
                argKeys: args ? Object.keys(args) : [],
              },
              // Empty tree snapshot - we don't have access to the full tree here
              {
                agents: [],
                claims: [],
                mainAgentId: null,
                activeAgentId: null,
              },
            );

            // Create claim via status bar (which owns the ClaimRegistry)
            statusBar?.createChildClaim(chatId, expectedChildName);

            logger.info(
              `[OpenResponses] Detected runSubagent call: "${expectedChildName}"`,
            );
          }
        } else if (part instanceof LanguageModelTextPart) {
          textPartCount++;
          accumulatedText += part.value;
          // Only log first few text parts to avoid spam
          if (textPartCount <= 3) {
            const preview = part.value.substring(0, 50).replace(/\n/g, "\\n");
            logger.debug(
              `[OpenResponses] Emitting text part #${textPartCount}: "${preview}..."`,
            );
          }
        }
        // Record time-to-first-content for summarization analysis
        if (firstContentTime === null) {
          firstContentTime = performance.now();
          timeToFirstToken = firstContentTime - requestStartTime;
          if (isSummarizationRequest) {
            logger.warn(
              `[OpenResponses] SUMMARIZATION TTFT: ${(timeToFirstToken / 1000).toFixed(1)}s ` +
                `(${model.id}, est ${estimatedInputTokens.toString()} tokens)`,
            );
          }
        }
        progress.report(part);
        responseSent = true;
      }

      // Handle completion
      if (adapted.done) {
        const topTypes = Array.from(eventTypeCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([t, c]) => `${t}:${c}`)
          .join(", ");

        logger.info(
          `[OpenResponses] Stream complete: ${eventCount} events, ${textPartCount} text, ${toolCallCount} tools (${topTypes})`,
        );

        // DIAGNOSTIC: Detect potential issues with tool call emission
        if (functionCallArgsEventsReceived > 0 && toolCallCount === 0) {
          logger.error(
            `[OpenResponses] BUG: Received ${functionCallArgsEventsReceived} function_call_arguments events but emitted 0 tool calls!`,
          );
        }

        result = {
          success: !adapted.error && !adapted.cancelled,
          ...(adapted.usage !== undefined && { usage: adapted.usage }),
          ...(adapted.error !== undefined && { error: adapted.error }),
          ...(adapted.cancelled !== undefined && {
            cancelled: adapted.cancelled,
          }),
          ...(adapted.responseId !== undefined && {
            responseId: adapted.responseId,
          }),
          ...(adapted.finishReason !== undefined && {
            finishReason: adapted.finishReason,
          }),
        };

        if (adapted.error) {
          markAgentError();
        } else if (adapted.cancelled) {
          markAgentCancelled();
        } else {
          markAgentComplete(adapted.usage);
        }

        // Log summarization timing
        if (isSummarizationRequest) {
          const totalDuration = performance.now() - requestStartTime;
          logger.warn(
            `[OpenResponses] SUMMARIZATION COMPLETE: ` +
              `total=${(totalDuration / 1000).toFixed(1)}s, ` +
              `ttft=${timeToFirstToken !== null ? (timeToFirstToken / 1000).toFixed(1) + "s" : "none"}, ` +
              `events=${eventCount.toString()}, ` +
              `textParts=${textPartCount.toString()}, ` +
              `input=${adapted.usage?.input_tokens.toString() ?? "?"}, ` +
              `output=${adapted.usage?.output_tokens.toString() ?? "?"}, ` +
              `model=${model.id}`,
          );
        }

        // Investigation logging — complete with success/error/cancelled
        void investigationHandle?.complete({
          status: adapted.error
            ? "error"
            : adapted.cancelled
              ? "cancelled"
              : "success",
          finishReason: adapted.finishReason ?? null,
          responseId: adapted.responseId ?? null,
          error: adapted.error ?? null,
          durationMs: performance.now() - requestStartTime,
          ttftMs: timeToFirstToken,
          eventCount,
          textPartCount,
          toolCallCount,
          usage: adapted.usage
            ? {
                input_tokens: adapted.usage.input_tokens,
                output_tokens: adapted.usage.output_tokens,
                cache_read_input_tokens:
                  adapted.usage.input_tokens_details?.cached_tokens,
                output_tokens_details: adapted.usage.output_tokens_details,
              }
            : null,
        });
        break;
      }
    }

    // Safety check: emit something if no response was sent
    if (!responseSent && !result.cancelled) {
      const diagnostic: NoResponseDiagnostic = {
        chatId,
        conversationId: chatOptions.conversationId,
        model: model.id,
        isSummarization: isSummarizationRequest,
        eventCount,
        textPartCount,
        toolCallCount,
        eventTypeCounts: Object.fromEntries(eventTypeCounts),
        accumulatedTextLength: accumulatedText.length,
        responseId: adapter.getResponseId(),
        finishReason: result.finishReason,
        streamError: result.error,
        streamCancelled: result.cancelled,
        timeToFirstTokenMs: timeToFirstToken,
        totalDurationMs: performance.now() - requestStartTime,
        resultState: JSON.stringify(result),
      };
      logger.error(
        `[NoResponse] Stream completed with no content:\n${JSON.stringify(diagnostic, null, 2)}`,
      );
      void errorCaptureLogger.captureError(
        buildErrorCaptureData("no-response", "No content received"),
        investigationHandle?.getEvents() ?? [],
      );
      void investigationHandle?.complete({
        status: "error",
        finishReason: result.finishReason ?? null,
        responseId: adapter.getResponseId() ?? null,
        error: "No content received",
        durationMs: performance.now() - requestStartTime,
        ttftMs: timeToFirstToken,
        eventCount,
        textPartCount,
        toolCallCount,
        usage: result.usage
          ? {
              input_tokens: result.usage.input_tokens,
              output_tokens: result.usage.output_tokens,
              cache_read_input_tokens:
                result.usage.input_tokens_details?.cached_tokens,
              output_tokens_details: result.usage.output_tokens_details,
            }
          : null,
      });
      progress.report(
        new LanguageModelTextPart(
          `**Error**: No response received from model. Please try again.`,
        ),
      );
      markAgentError();
      result = { success: false, error: "No content received" };
    }

    return result;
  } catch (error) {
    // Handle abort/cancellation
    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.message.includes("abort"))
    ) {
      if (timedOut) {
        // Streaming inactivity timeout — report as error, not cancellation
        const timeoutDuration = performance.now() - requestStartTime;
        logger.error(
          `[OpenResponses] Request timed out after ${(STREAM_INACTIVITY_TIMEOUT_MS / 1000).toString()}s of inactivity ` +
            `(${eventCount} events received, total ${(timeoutDuration / 1000).toFixed(1)}s, ` +
            `summarization=${isSummarizationRequest.toString()}, ttft=${timeToFirstToken !== null ? (timeToFirstToken / 1000).toFixed(1) + "s" : "none"})`,
        );
        if (!responseSent) {
          progress.report(
            new LanguageModelTextPart(
              `\n\n**Error:** Request timed out — the model did not respond within ${(STREAM_INACTIVITY_TIMEOUT_MS / 1000).toString()} seconds. ` +
                `This can happen with large conversations during summarization. Try starting a new conversation.\n\n`,
            ),
          );
        }
        markAgentError();

        // Investigation logging — timeout
        void investigationHandle?.complete({
          status: "timeout",
          finishReason: null,
          responseId: null,
          error: "Stream inactivity timeout",
          durationMs: performance.now() - requestStartTime,
          ttftMs: timeToFirstToken,
          eventCount,
          textPartCount,
          toolCallCount,
          usage: null,
        });
        void errorCaptureLogger.captureError(
          buildErrorCaptureData("timeout", "Stream inactivity timeout"),
          investigationHandle?.getEvents() ?? [],
        );

        return { success: false, error: "Stream inactivity timeout" };
      }
      logger.debug(`[OpenResponses] Request was cancelled`);
      markAgentCancelled();

      // Investigation logging — cancellation
      void investigationHandle?.complete({
        status: "cancelled",
        finishReason: null,
        responseId: null,
        error: null,
        durationMs: performance.now() - requestStartTime,
        ttftMs: timeToFirstToken,
        eventCount,
        textPartCount,
        toolCallCount,
        usage: null,
      });

      return { success: false, cancelled: true };
    }

    // Handle API errors
    const errorMessage =
      error instanceof OpenResponsesError
        ? `${error.message} (${error.code ?? error.status})`
        : error instanceof Error
          ? error.message
          : "Unknown error";

    logger.error(`[OpenResponses] Request failed: ${errorMessage}`);

    // Detect auth errors (401) and show actionable message
    if (
      (error instanceof OpenResponsesError && error.status === 401) ||
      errorMessage.includes("401")
    ) {
      const lowerErrorMessage = errorMessage.toLowerCase();
      const isExpired =
        lowerErrorMessage.includes("expired") ||
        lowerErrorMessage.includes("expire");
      const authMessage = isExpired
        ? ERROR_MESSAGES.AUTH_KEY_EXPIRED
        : ERROR_MESSAGES.AUTH_KEY_INVALID;
      void vscode.window
        .showErrorMessage(authMessage, "Manage Authentication")
        .then((selection) => {
          if (selection === "Manage Authentication") {
            void vscode.commands.executeCommand(`${EXTENSION_ID}.manage`);
          }
        });
    }

    // Extract token info from "input too long" errors for compaction triggering
    let tokenInfo = extractTokenInfoFromDetails(error);
    tokenInfo ??= extractTokenCountFromError(error);

    // Fallback: if error indicates "too long" but we couldn't parse exact count
    if (
      !tokenInfo &&
      errorMessage.toLowerCase().includes("too long") &&
      model.maxInputTokens > 0
    ) {
      tokenInfo = {
        actualTokens: model.maxInputTokens + 1,
        maxTokens: model.maxInputTokens,
      };
      logger.info(
        `[OpenResponses] Using maxInputTokens fallback: ${tokenInfo.actualTokens} > ${model.maxInputTokens}`,
      );
    }

    if (tokenInfo) {
      logger.info(
        `[OpenResponses] Token info: ${tokenInfo.actualTokens} (max: ${tokenInfo.maxTokens ?? "unknown"})`,
      );
    }

    // Emit error to user if we haven't sent anything yet
    if (!responseSent) {
      progress.report(
        new LanguageModelTextPart(`\n\n**Error:** ${errorMessage}\n\n`),
      );
    }

    markAgentError();

    // Investigation logging — error
    void investigationHandle?.complete({
      status: "error",
      finishReason: null,
      responseId: null,
      error: errorMessage,
      durationMs: performance.now() - requestStartTime,
      ttftMs: timeToFirstToken,
      eventCount,
      textPartCount,
      toolCallCount,
      usage: null,
    });
    void errorCaptureLogger.captureError(
      buildErrorCaptureData("api-error", errorMessage),
      investigationHandle?.getEvents() ?? [],
    );

    return tokenInfo
      ? { success: false, error: errorMessage, tokenInfo }
      : { success: false, error: errorMessage };
  } finally {
    // Clear streaming inactivity timer
    if (streamTimeoutId !== null) {
      clearTimeout(streamTimeoutId);
    }
    abortSubscription.dispose();
    adapter.reset();
    if (!agentCompleted && statusBar) {
      markAgentError();
    }
  }
}

/**
 * Detect if a request is a Copilot summarization request.
 *
 * Copilot's ConversationHistorySummarizer (Path B in agentIntent.ts) sends the
 * full conversation history with a distinctive prompt. The request arrives at our
 * provider through ExtensionContributedChatEndpoint, which drops `stream: false`
 * and `temperature: 0`, so we detect by message content.
 *
 * Detection signals (any one is sufficient):
 * 1. Last user message contains "Summarize the conversation history"
 * 2. System message contains "<Tag name='summary'>" (SummaryPrompt template)
 * 3. User message contains "conversation-summary" tag from prior summarization
 */
export function detectSummarizationRequest(
  messages: readonly LanguageModelChatMessage[],
): boolean {
  // Role values: 1=User, 2=Assistant, 3=System (System is not in the public enum)
  const ROLE_USER = 1;
  const ROLE_SYSTEM = 3;

  // Check last user message for summarization instruction
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || (msg.role as number) !== ROLE_USER) continue;

    const text = extractMessageText(msg);
    if (text.includes("Summarize the conversation history")) {
      return true;
    }
    // Only check the last user message
    break;
  }

  // Check system messages for SummaryPrompt template markers
  for (const msg of messages) {
    if ((msg.role as number) !== ROLE_SYSTEM) continue;
    const text = extractMessageText(msg);
    if (
      text.includes("<Tag name='summary'>") ||
      text.includes(
        "comprehensive, detailed summary of the entire conversation",
      )
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Extract text content from a LanguageModelChatMessage.
 * Returns the concatenated text of all text parts (first 2000 chars for perf).
 */
function extractMessageText(msg: LanguageModelChatMessage): string {
  let text = "";
  for (const part of msg.content) {
    if (part instanceof LanguageModelTextPart) {
      text += part.value;
      if (text.length > 2000) break; // Enough for detection
    }
  }
  return text;
}
