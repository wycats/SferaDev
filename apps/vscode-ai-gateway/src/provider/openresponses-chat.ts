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
import {
  type CancellationToken,
  type LanguageModelChatInformation,
  type LanguageModelChatMessage,
  type LanguageModelResponsePart,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  type Progress,
  type ProvideLanguageModelChatResponseOptions,
} from "vscode";
import type { ConfigService } from "../config.js";
import {
  extractTokenCountFromError,
  type ExtractedTokenInfo,
  logger,
} from "../logger.js";
import type { TokenStatusBar } from "../status-bar.js";
import { saveSuspiciousRequest } from "./debug-utils.js";
import { extractTokenInfoFromDetails } from "./error-extraction.js";
import { translateRequest } from "./request-builder.js";
import { type AdaptedEvent, StreamAdapter } from "./stream-adapter.js";
import { UsageTracker } from "./usage-tracker.js";

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
  const { configService, statusBar, apiKey, estimatedInputTokens, chatId } =
    chatOptions;

  // TRACE: Log raw VS Code messages with actual role values
  const roleNames: Record<number, string> = {
    1: "User",
    2: "Assistant",
    3: "System",
  };
  logger.trace(
    `[OpenResponses] Received ${chatMessages.length} messages: ${chatMessages.map((m) => roleNames[m.role as number] ?? `Unknown(${m.role})`).join(", ")}`,
  );

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

  const adapter = new StreamAdapter();
  const usageTracker = new UsageTracker();

  // Set up abort handling
  const abortController = new AbortController();
  const abortSubscription = token.onCancellationRequested(() => {
    abortController.abort();
  });

  // Start tracking in status bar
  statusBar?.startAgent(
    chatId,
    estimatedInputTokens,
    model.maxInputTokens,
    model.id,
  );

  let responseSent = false;
  let result: OpenResponsesChatResult = { success: false };

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
    const requestBody: CreateResponseBody = {
      model: model.id,
      input,
      stream: true,
      temperature: 0.1,
      top_p: 1,
      max_output_tokens:
        (options.modelOptions?.["maxOutputTokens"] as number | undefined) ??
        model.maxOutputTokens,
    };

    if (instructions) {
      requestBody.instructions = instructions;
    }

    if (tools.length > 0) {
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

    // Stream the response
    let toolCallCount = 0;
    let textPartCount = 0;
    let eventCount = 0;
    let functionCallArgsEventsReceived = 0;
    const eventTypeCounts = new Map<string, number>();
    // Accumulate all text output for debugging suspicious requests
    let accumulatedText = "";
    for await (const event of client.createStreamingResponse(
      requestBody,
      abortController.signal,
    )) {
      eventCount++;
      const eventType = (event as { type?: string }).type ?? "unknown";
      eventTypeCounts.set(eventType, (eventTypeCounts.get(eventType) ?? 0) + 1);

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

        // Save suspicious request if tools were provided but model stopped without calling any
        if (
          textPartCount > 0 &&
          toolCallCount === 0 &&
          adapted.finishReason === "stop" &&
          tools.length > 0
        ) {
          const textPreview = accumulatedText.substring(0, 500);
          logger.warn(
            `[OpenResponses] SUSPICIOUS: Tools provided but model stopped without calling any. Preview: "${textPreview.substring(0, 100)}..."`,
          );
          saveSuspiciousRequest(requestBody, {
            timestamp: new Date().toISOString(),
            finishReason: adapted.finishReason,
            textPartCount,
            toolCallCount,
            toolsProvided: tools.length,
            textPreview,
            usage: adapted.usage,
          });
        }

        result = {
          success: !adapted.error,
          ...(adapted.usage !== undefined && { usage: adapted.usage }),
          ...(adapted.error !== undefined && { error: adapted.error }),
          ...(adapted.responseId !== undefined && {
            responseId: adapted.responseId,
          }),
          ...(adapted.finishReason !== undefined && {
            finishReason: adapted.finishReason,
          }),
        };

        // Track usage
        if (adapted.usage) {
          usageTracker.record(chatId, adapted.usage);
          logger.info(
            `[OpenResponses] Response: ${adapted.usage.input_tokens} in, ${adapted.usage.output_tokens} out tokens`,
          );
          statusBar?.completeAgent(chatId, {
            inputTokens: adapted.usage.input_tokens,
            outputTokens: adapted.usage.output_tokens,
            maxInputTokens: model.maxInputTokens,
            modelId: model.id,
          });
        }
        break;
      }
    }

    // Safety check: emit something if no response was sent
    if (!responseSent) {
      logger.error(
        `[OpenResponses] Stream completed with no content for chat ${chatId}`,
      );
      progress.report(
        new LanguageModelTextPart(
          `**Error**: No response received from model. Please try again.`,
        ),
      );
      result = { success: false, error: "No content received" };
    }

    return result;
  } catch (error) {
    // Handle abort/cancellation
    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.message.includes("abort"))
    ) {
      logger.debug(`[OpenResponses] Request was cancelled`);
      return { success: false, error: "Cancelled" };
    }

    // Handle API errors
    const errorMessage =
      error instanceof OpenResponsesError
        ? `${error.message} (${error.code ?? error.status})`
        : error instanceof Error
          ? error.message
          : "Unknown error";

    logger.error(`[OpenResponses] Request failed: ${errorMessage}`);

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

    statusBar?.errorAgent(chatId);
    return tokenInfo
      ? { success: false, error: errorMessage, tokenInfo }
      : { success: false, error: errorMessage };
  } finally {
    abortSubscription.dispose();
    adapter.reset();
  }
}
