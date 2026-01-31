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
import {
  saveSuspiciousRequest,
  type SuspiciousRequestContext,
} from "./debug-utils.js";
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
  logger.trace(
    `[OpenResponses] Received ${chatMessages.length.toString()} messages from VS Code`,
  );
  chatMessages.forEach((msg, i) => {
    // Log the raw numeric role value to catch unknown roles (e.g., System=3)
    const roleValue = msg.role as number;
    const roleNames: Record<number, string> = {
      1: "User",
      2: "Assistant",
      3: "System",
    };
    const roleName = roleNames[roleValue] ?? `Unknown(${String(roleValue)})`;
    const contentTypes = msg.content.map((p) => p.constructor.name).join(", ");
    logger.trace(
      `[OpenResponses] Message[${i.toString()}]: role=${roleName}(${String(roleValue)}), parts=[${contentTypes}]`,
    );
  });

  // Create client with trace logging
  const client = createClient({
    baseUrl: configService.openResponsesBaseUrl,
    apiKey,
    timeout: configService.timeout,
    log: (level, message, data) => {
      const formatted =
        data !== undefined
          ? `${message}: ${JSON.stringify(data, null, 2)}`
          : message;
      switch (level) {
        case "trace":
          logger.trace(formatted);
          break;
        case "debug":
          logger.debug(formatted);
          break;
        case "info":
          logger.info(formatted);
          break;
        case "warn":
          logger.warn(formatted);
          break;
        case "error":
          logger.error(formatted);
          break;
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

    // TRACE: Log the first few input items to debug structure
    logger.trace(
      `[OpenResponses] Request has ${input.length.toString()} input items`,
    );
    input.slice(0, 3).forEach((item, i) => {
      logger.trace(
        `[OpenResponses] input[${i.toString()}]: type=${item.type ?? "unknown"}, role=${"role" in item ? item.role : "N/A"}`,
      );
      if ("content" in item && Array.isArray(item.content)) {
        const contentTypes = (item.content as { type?: string }[])
          .map((c) => c.type ?? "unknown")
          .join(", ");
        logger.trace(
          `[OpenResponses] input[${i.toString()}] content types: [${contentTypes}]`,
        );
      }
    });

    // Stream the response
    let toolCallCount = 0;
    let textPartCount = 0;
    let eventCount = 0;
    let functionCallEventsReceived = 0;
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

      // TRACE: Log raw event data for debugging (only for function-related events to avoid spam)
      if (
        eventType.includes("function_call") ||
        eventType.includes("output_item")
      ) {
        functionCallEventsReceived++;
        logger.debug(
          `[OpenResponses] Function-related event #${functionCallEventsReceived.toString()}: ${eventType}`,
        );
        // Log the full event at trace level for debugging
        try {
          logger.trace(
            `[OpenResponses] Raw event data: ${JSON.stringify(event)}`,
          );
        } catch {
          logger.trace(
            `[OpenResponses] Raw event (non-serializable): ${eventType}`,
          );
        }
      }

      // Track function_call_arguments events specifically - these indicate actual tool calls
      if (eventType.includes("function_call_arguments")) {
        functionCallArgsEventsReceived++;
      }

      if (eventCount <= 25) {
        logger.trace(
          `[OpenResponses] Stream event #${eventCount.toString()}: ${eventType}`,
        );
      }
      if (eventType === "response.completed") {
        const response = (
          event as { response: { id: string; output?: unknown } }
        ).response;
        const outputIsArray = Array.isArray(response.output);
        const outputLength = outputIsArray
          ? (response.output as unknown[]).length
          : undefined;
        logger.debug(
          `[OpenResponses] response.completed received (id=${response.id}, outputArray=${String(outputIsArray)}, outputLen=${String(outputLength ?? "n/a")})`,
        );
      }

      const adapted = adapter.adapt(event);

      // Report all parts to VS Code
      for (const part of adapted.parts) {
        // Log part types to diagnose tool call handling
        if (part instanceof LanguageModelToolCallPart) {
          toolCallCount++;
          logger.info(
            `[OpenResponses] Emitting tool call #${toolCallCount.toString()}: ${part.name} (callId: ${part.callId})`,
          );
        } else if (part instanceof LanguageModelTextPart) {
          textPartCount++;
          accumulatedText += part.value;
          // Only log first few text parts to avoid spam
          if (textPartCount <= 3) {
            const preview = part.value.substring(0, 50).replace(/\n/g, "\\n");
            logger.debug(
              `[OpenResponses] Emitting text part #${textPartCount.toString()}: "${preview}..."`,
            );
          }
        }
        progress.report(part);
        responseSent = true;
      }

      // Handle completion
      if (adapted.done) {
        logger.debug(
          `[OpenResponses] Adapter done (finishReason=${adapted.finishReason ?? "n/a"}, parts=${adapted.parts.length.toString()})`,
        );
        const topTypes = Array.from(eventTypeCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([t, c]) => `${t}:${c.toString()}`)
          .join(", ");
        logger.debug(
          `[OpenResponses] Stream event type counts (top): ${topTypes}`,
        );

        // Log summary of what was emitted
        logger.info(
          `[OpenResponses] Stream summary: ${eventCount.toString()} events, ${textPartCount.toString()} text parts, ${toolCallCount.toString()} tool calls emitted, ${functionCallArgsEventsReceived.toString()} function_call_arguments events`,
        );

        // DIAGNOSTIC: Detect potential issues with tool call emission
        // Only warn if we received function_call_arguments events but didn't emit tool calls
        if (functionCallArgsEventsReceived > 0 && toolCallCount === 0) {
          logger.error(
            `[OpenResponses] BUG: Received ${functionCallArgsEventsReceived.toString()} function_call_arguments events but emitted 0 tool calls! ` +
              `Event types: ${topTypes}. ` +
              `Finish reason: ${adapted.finishReason ?? "unknown"}`,
          );
        }

        // Log when we have text but no tool calls and finish reason is 'stop'
        // This is the "pause" pattern but may be intentional model behavior
        if (
          textPartCount > 0 &&
          toolCallCount === 0 &&
          adapted.finishReason === "stop"
        ) {
          logger.debug(
            `[OpenResponses] Text-only response (no tool calls): ${textPartCount.toString()} text parts, finish reason: stop`,
          );

          // Save suspicious request if tools were provided - this is the "pause" pattern
          // where model says "Let me check..." but stops without making tool calls
          if (tools.length > 0) {
            logger.warn(
              `[OpenResponses] SUSPICIOUS: Tools provided but model stopped without calling any. Saving request for replay.`,
            );
            // Use accumulated text from the stream
            const textPreview = accumulatedText.substring(0, 500);
            logger.warn(
              `[OpenResponses] Model output preview: "${textPreview.substring(0, 200)}${textPreview.length > 200 ? "..." : ""}"`,
            );
            const suspiciousContext: SuspiciousRequestContext = {
              timestamp: new Date().toISOString(),
              finishReason: adapted.finishReason,
              textPartCount,
              toolCallCount,
              toolsProvided: tools.length,
              textPreview,
              usage: adapted.usage,
            };
            saveSuspiciousRequest(requestBody, suspiciousContext);
          }
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
            `[OpenResponses] Response completed: ${adapted.usage.input_tokens.toString()} input, ` +
              `${adapted.usage.output_tokens.toString()} output tokens`,
          );

          // Update status bar with actual usage
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
          `**Error**: No response received from model. The request completed but the model returned no content. Please try again.`,
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
        ? `${error.message} (${String(error.code ?? error.status)})`
        : error instanceof Error
          ? error.message
          : "Unknown error";

    logger.error(`[OpenResponses] Request failed: ${errorMessage}`);

    // Extract token info from "input too long" errors for compaction triggering.
    // First try to get structured data from OpenResponsesError.details
    let tokenInfo = extractTokenInfoFromDetails(error);

    // Fall back to regex extraction from error message
    tokenInfo ??= extractTokenCountFromError(error);

    // Final fallback: if error indicates "too long" but we couldn't parse exact count,
    // use maxInputTokens + 1 to guarantee we trigger compaction
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
        `[OpenResponses] Using maxInputTokens fallback for compaction trigger: ` +
          `${tokenInfo.actualTokens.toString()} > ${model.maxInputTokens.toString()}`,
      );
    }

    if (tokenInfo) {
      logger.info(
        `[OpenResponses] Token info for compaction: ${tokenInfo.actualTokens.toString()} tokens ` +
          `(max: ${String(tokenInfo.maxTokens ?? "unknown")})`,
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
