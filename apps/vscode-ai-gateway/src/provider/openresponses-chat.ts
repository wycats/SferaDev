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

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type CreateResponseBody,
  createClient,
  type FunctionToolParam,
  type InputImageContentParamAutoParam,
  type InputTextContentParam,
  type ItemParam,
  OpenResponsesError,
  type OutputTextContentParam,
  type Usage,
} from "openresponses-client";
import {
  type CancellationToken,
  type LanguageModelChatInformation,
  type LanguageModelChatMessage,
  LanguageModelChatMessageRole,
  LanguageModelChatToolMode,
  LanguageModelDataPart,
  type LanguageModelResponsePart,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
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
import { type AdaptedEvent, StreamAdapter } from "./stream-adapter.js";
import { UsageTracker } from "./usage-tracker.js";

/**
 * VS Code proposed API: LanguageModelChatMessageRole.System = 3
 * See: vscode.proposed.languageModelSystem.d.ts
 * This is used by VS Code Copilot to send system prompts.
 */
const VSCODE_SYSTEM_ROLE = 3;

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
 * Save a suspicious request for replay with the test script.
 * This is called when we detect a premature stop pattern (text but no tool calls).
 */
function saveSuspiciousRequest(
  requestBody: CreateResponseBody,
  context: {
    timestamp: string;
    finishReason: string | undefined;
    textPartCount: number;
    toolCallCount: number;
    toolsProvided: number;
    textPreview: string;
    usage: { input_tokens: number; output_tokens: number } | undefined;
  },
): void {
  try {
    // Find workspace root by looking for package.json
    const workspaceRoot = process.cwd();
    const logsDir = resolve(workspaceRoot, ".logs");

    // Ensure logs directory exists
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }

    const filePath = resolve(logsDir, "last-suspicious-request.json");
    const data = {
      request: requestBody,
      context,
    };

    writeFileSync(filePath, JSON.stringify(data, null, 2));
    logger.info(
      `[OpenResponses] Saved suspicious request to ${filePath} for replay`,
    );
  } catch (err) {
    logger.warn(
      `[OpenResponses] Failed to save suspicious request: ${String(err)}`,
    );
  }
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

/**
 * Translate a VS Code chat request to OpenResponses format.
 */
function translateRequest(
  messages: readonly LanguageModelChatMessage[],
  options: ProvideLanguageModelChatResponseOptions,
  configService: ConfigService,
): {
  input: ItemParam[];
  instructions?: string;
  tools: FunctionToolParam[];
  toolChoice: "auto" | "required" | "none";
} {
  const input: ItemParam[] = [];

  // Handle system prompt from config
  const systemPromptEnabled = configService.systemPromptEnabled;
  const systemPromptMessage = configService.systemPromptMessage;
  let instructions: string | undefined;

  if (systemPromptEnabled && systemPromptMessage.trim()) {
    // VS Code does not provide a system/developer role in LanguageModelChatMessageRole.
    // System prompts are passed via options (config-driven here), so we map them to
    // OpenResponses `instructions` instead of synthesizing a message.
    // If VS Code introduces system/developer roles in the future, they will be mapped
    // explicitly in translateMessage via resolveOpenResponsesRole().
    // Use instructions field for system prompt (OpenResponses preferred approach)
    instructions = systemPromptMessage;
  }

  // Build tool name map for resolving tool result -> tool call relationships
  const toolNameMap = buildToolNameMap(messages);

  // Handle VS Code System role (proposed API): VS Code Copilot sends the system
  // prompt using role=3 (System). We extract it and use the `instructions` field.
  let messagesToProcess = messages;
  const systemPromptFromMessages = extractSystemPrompt(messages);
  if (systemPromptFromMessages) {
    logger.info(
      `[OpenResponses] Extracted system prompt (${systemPromptFromMessages.length.toString()} chars) from VS Code System role, using as instructions`,
    );
    // Use the system prompt as instructions (may override config-based instructions)
    instructions = systemPromptFromMessages;
    // Skip the first message when processing
    messagesToProcess = messages.slice(1);
  }

  // Convert each message
  for (const message of messagesToProcess) {
    const translated = translateMessage(message, toolNameMap);
    input.push(...translated);
  }

  // CRITICAL: Filter out any items with empty content to prevent API 400 errors
  // This can happen when messages contain only unsupported parts (e.g., tool calls
  // that we intentionally skip, or data parts in assistant roles)
  const validInput = input.filter((item) => {
    if (item.type !== "message") return true; // Non-message items are kept
    const msg = item as { content?: string | unknown[] };
    if (typeof msg.content === "string") {
      return msg.content.length > 0;
    }
    if (Array.isArray(msg.content)) {
      return msg.content.length > 0;
    }
    return true; // Keep if content is not string or array (shouldn't happen)
  });

  // Log if we filtered anything
  if (validInput.length !== input.length) {
    logger.warn(
      `[OpenResponses] Filtered ${(input.length - validInput.length).toString()} empty message(s) from input`,
    );
  }

  // CRITICAL FIX #1: Consolidate consecutive same-role messages.
  // Claude models expect alternating user/assistant messages. When tool results
  // are emitted as separate user messages, we get patterns like user→user→user
  // which causes the model to stop early with minimal output.
  // See: packages/openresponses-client/IMPLEMENTATION_CONSTRAINTS.md
  const consolidatedInput = consolidateConsecutiveMessages(validInput);
  if (consolidatedInput.length !== validInput.length) {
    logger.info(
      `[OpenResponses] Consolidated ${validInput.length.toString()} messages to ${consolidatedInput.length.toString()} (merged consecutive same-role messages)`,
    );
  }

  // CRITICAL FIX #2: Prepend system prompt as a `developer` message for non-OpenAI providers.
  // The Vercel AI Gateway only passes `instructions` via `providerOptions.openai.instructions`,
  // which is ignored by Anthropic and other providers. By prepending a `developer` role message,
  // the gateway's convertMessageItem() converts it to a system message that works universally.
  // We keep `instructions` for OpenAI compatibility but also add a developer message for others.
  let finalInput = consolidatedInput;
  if (instructions) {
    const developerMessage: ItemParam = {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: instructions }],
    };
    finalInput = [developerMessage, ...consolidatedInput];
    logger.info(
      `[OpenResponses] Prepended developer message (${instructions.length.toString()} chars) for non-OpenAI provider compatibility`,
    );
  }

  // Convert tools
  const tools: FunctionToolParam[] = [];
  for (const { name, description, inputSchema } of options.tools ?? []) {
    tools.push({
      type: "function",
      name,
      description,
      // Cast to null to satisfy the optional parameters field
      // The API accepts the schema but TypeScript types are strict
      parameters: (inputSchema ?? {
        type: "object",
        properties: {},
      }) as FunctionToolParam["parameters"],
      strict: false,
    } as unknown as FunctionToolParam);
  }

  // Determine tool choice
  let toolChoice: "auto" | "required" | "none" = "auto";
  if (options.toolMode === LanguageModelChatToolMode.Required) {
    toolChoice = "required";
  } else if (tools.length === 0) {
    toolChoice = "none";
  }

  // Keep `instructions` for OpenAI provider compatibility but use finalInput
  // which includes the developer message for non-OpenAI providers
  if (instructions) {
    return { input: finalInput, instructions, tools, toolChoice };
  }

  return { input: finalInput, tools, toolChoice };
}

/**
 * Consolidate consecutive messages with the same role into single messages.
 *
 * Claude models expect alternating user/assistant roles. When tool results
 * are emitted as separate user messages, patterns like user→user→user cause
 * degraded model behavior (stopping early, not calling tools).
 *
 * This function merges consecutive same-role messages by concatenating their
 * text content with a separator.
 *
 * @param items - Array of message items to consolidate
 * @returns Consolidated array with no consecutive same-role messages
 */
function consolidateConsecutiveMessages(items: ItemParam[]): ItemParam[] {
  if (items.length === 0) return items;

  const result: ItemParam[] = [];
  let currentRole: string | null = null;
  let currentContent: string[] = [];

  // Helper to get role from an item
  function getRole(item: ItemParam): string | null {
    if (item.type === "message" && "role" in item) {
      return item.role;
    }
    return null;
  }

  // Helper to get text content from an item
  function getTextContent(item: ItemParam): string | null {
    if (item.type !== "message" || !("content" in item)) return null;
    const content = item.content;

    if (typeof content === "string") {
      return content;
    }

    if (Array.isArray(content)) {
      // Extract text from content arrays
      const textParts = content
        .filter(
          (part): part is { type: string; text: string } =>
            "type" in part &&
            (part.type === "input_text" || part.type === "output_text") &&
            "text" in part,
        )
        .map((part) => part.text);

      return textParts.length > 0 ? textParts.join("\n") : null;
    }

    return null;
  }

  // Helper to flush accumulated content as a message
  function flushMessage(): void {
    if (currentRole && currentContent.length > 0) {
      const mergedText = currentContent.join("\n\n---\n\n");
      result.push({
        type: "message",
        role: currentRole as "user" | "assistant" | "developer",
        content: mergedText,
      } as ItemParam);
    }
    currentContent = [];
  }

  for (const item of items) {
    const role = getRole(item);
    const text = getTextContent(item);

    // Non-message items (like function_call_output) pass through as-is
    if (role === null) {
      flushMessage();
      result.push(item);
      currentRole = null;
      continue;
    }

    // If role changed, flush and start new accumulation
    if (role !== currentRole) {
      flushMessage();
      currentRole = role;
    }

    // Accumulate text content
    if (text) {
      currentContent.push(text);
    }
  }

  // Flush any remaining content
  flushMessage();

  return result;
}

/**
 * Detect image MIME type from magic bytes.
 * The API requires specific types (image/jpeg, image/png, image/gif, image/webp)
 * but VS Code may pass "image/*" wildcard which gets rejected.
 */
function detectImageMimeType(
  data: Uint8Array,
  fallbackMimeType: string,
): string {
  // If already a specific type, use it
  if (
    fallbackMimeType !== "image/*" &&
    !fallbackMimeType.includes("*") &&
    fallbackMimeType.startsWith("image/")
  ) {
    return fallbackMimeType;
  }

  // Detect from magic bytes
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return "image/png";
  }

  // JPEG: FF D8 FF
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }

  // GIF: 47 49 46 38 (GIF8)
  if (
    data[0] === 0x47 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x38
  ) {
    return "image/gif";
  }

  // WebP: 52 49 46 46 ... 57 45 42 50 (RIFF....WEBP)
  if (
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return "image/webp";
  }

  // Default to PNG if we can't detect (most common for screenshots)
  logger.warn(
    `[OpenResponses] Could not detect image type from magic bytes, defaulting to image/png`,
  );
  return "image/png";
}

/**
 * Build a mapping of tool call IDs to tool names.
 */
function buildToolNameMap(
  messages: readonly LanguageModelChatMessage[],
): Map<string, string> {
  const map = new Map<string, string>();

  for (const message of messages) {
    for (const part of message.content) {
      if (part instanceof LanguageModelToolCallPart) {
        map.set(part.callId, part.name);
      }
    }
  }

  return map;
}

/**
 * Translate a single VS Code message to OpenResponses items.
 */
function translateMessage(
  message: LanguageModelChatMessage,
  _toolNameMap: Map<string, string>,
): ItemParam[] {
  void _toolNameMap;
  const items: ItemParam[] = [];
  const role = message.role;
  const openResponsesRole = resolveOpenResponsesRole(role);

  // DEBUG: Log the incoming role
  logger.trace(
    `[OpenResponses] translateMessage role=${String(role)} (User=${String(LanguageModelChatMessageRole.User)}, Assistant=${String(LanguageModelChatMessageRole.Assistant)}) mapped=${openResponsesRole}`,
  );

  // Collect content parts
  type UserContent = InputTextContentParam | InputImageContentParamAutoParam;
  type AssistantContent = OutputTextContentParam;
  const contentParts: (UserContent | AssistantContent)[] = [];

  for (const part of message.content) {
    if (part instanceof LanguageModelTextPart) {
      // Text content
      // Use input_text for User role, and also for unknown roles (which become user messages)
      // Only use output_text for Assistant role
      if (openResponsesRole === "assistant") {
        contentParts.push({
          type: "output_text",
          text: part.value,
        });
      } else {
        contentParts.push({
          type: "input_text",
          text: part.value,
        });
      }
    } else if (part instanceof LanguageModelDataPart) {
      // Binary data - images
      if (part.mimeType.startsWith("image/") && openResponsesRole === "user") {
        const base64 = Buffer.from(part.data).toString("base64");
        // Resolve the actual mime type - VS Code may pass "image/*" wildcard
        // which the API rejects. Detect from magic bytes if needed.
        const resolvedMimeType = detectImageMimeType(part.data, part.mimeType);
        const imageUrl = `data:${resolvedMimeType};base64,${base64}`;
        contentParts.push({
          type: "input_image",
          image_url: imageUrl,
        });
      }
    } else if (part instanceof LanguageModelToolCallPart) {
      // CRITICAL: `function_call` is NOT a valid input item in OpenResponses!
      // See: packages/openresponses-client/IMPLEMENTATION_CONSTRAINTS.md
      //
      // Avoid adding any tool-call text to assistant history to reduce
      // mimicry risk. The tool result (below) carries the useful context.
    } else if (part instanceof LanguageModelToolResultPart) {
      // CRITICAL: `function_call_output` requires preceding tool_use context
      // that the Vercel AI Gateway doesn't synthesize.
      // See: packages/openresponses-client/IMPLEMENTATION_CONSTRAINTS.md
      //
      // Strategy: Emit tool results as USER message text, so the assistant
      // doesn't see tool history in its own prior turns.
      if (contentParts.length > 0) {
        const messageItem = createMessageItem(openResponsesRole, contentParts);
        if (messageItem) {
          items.push(messageItem);
        }
        contentParts.length = 0;
      }

      const output =
        typeof part.content === "string"
          ? part.content
          : JSON.stringify(part.content);
      if (output.trim() === "") {
        logger.debug("[OpenResponses] Skipping empty tool result content");
        continue;
      }

      const toolResultItem = createMessageItem("user", [
        {
          type: "input_text",
          text: `Context (tool result):\n${output}`,
        },
      ]);
      if (toolResultItem) {
        items.push(toolResultItem);
      }
    }
  }

  // Flush remaining content
  if (contentParts.length > 0) {
    const messageItem = createMessageItem(openResponsesRole, contentParts);
    if (messageItem) {
      items.push(messageItem);
    }
  }

  return items;
}

/**
 * Create a message item from content parts.
 *
 * NOTE: We deliberately omit "system" role here. The OpenResponses API rejects
 * `role: "system"` in input messages. Use the `instructions` field for system
 * prompts, or use "developer" role for message-based system-like content.
 *
 * CRITICAL: The Vercel AI Gateway/OpenResponses API requires message content
 * to be a STRING, not an array of content objects. If content is structured
 * as an array, the API returns 400 Invalid input.
 */
function createMessageItem(
  role: "user" | "assistant" | "developer",
  content: (
    | InputTextContentParam
    | InputImageContentParamAutoParam
    | OutputTextContentParam
  )[],
): ItemParam | null {
  // Convert content array to string
  // For text-only content: concatenate all text parts
  // For mixed content (text + images): use array format (but this is rare)

  // Check if content is text-only
  const textOnly = content.every(
    (part) => part.type === "input_text" || part.type === "output_text",
  );

  if (textOnly) {
    // Concatenate all text parts into a single string
    const textContent = content
      .map((part) => ("text" in part ? part.text : ""))
      .join("");
    if (textContent.trim() === "") {
      return null;
    }

    return {
      type: "message",
      role,
      content: textContent,
    } as ItemParam;
  }

  // For mixed content (has images), keep as array
  // This is mainly for user messages with images
  switch (role) {
    case "user": {
      // For user with mixed content, keep the array but filter empty items
      const filteredContent = content.filter((part) => {
        if ("text" in part) return part.text.length > 0;
        return true; // Keep images
      });
      if (filteredContent.length === 0) {
        return null;
      }
      return {
        type: "message",
        role: "user",
        content: filteredContent as (
          | InputTextContentParam
          | InputImageContentParamAutoParam
        )[],
      };
    }

    case "assistant": {
      // Assistant should never have images, so this shouldn't happen
      // But if it does, convert to text
      const assText = content
        .map((part) => ("text" in part ? part.text : ""))
        .join("");
      if (assText.trim() === "") {
        return null;
      }
      return {
        type: "message",
        role: "assistant",
        content: assText,
      };
    }

    case "developer": {
      // Developer messages are typically text-only
      const devText = content
        .map((part) => ("text" in part ? part.text : ""))
        .join("");
      if (devText.trim() === "") {
        return null;
      }
      return {
        type: "message",
        role: "developer",
        content: devText,
      };
    }
  }
}

/**
 * Extract system prompt from VS Code messages.
 *
 * ⚠️ CRITICAL - DO NOT REMOVE THIS FUNCTION ⚠️
 *
 * VS Code Copilot uses the proposed System role (role=3) to send system prompts.
 * See: vscode.proposed.languageModelSystem.d.ts
 *
 * Without this extraction:
 * - The system prompt gets translated as a regular message
 * - Claude sees incorrect conversation structure
 * - Tool calling breaks
 *
 * If detected, returns the system prompt text to be used as `instructions`.
 */
function extractSystemPrompt(
  messages: readonly LanguageModelChatMessage[],
): string | undefined {
  if (messages.length === 0) return undefined;

  const firstMessage = messages[0];

  // Check for VS Code System role (proposed API, role=3)
  // Cast to number for comparison since it's not in stable types
  const messageRole = firstMessage.role as number;

  logger.info(
    `[OpenResponses] System prompt check: first message role=${String(messageRole)}, expected System=${String(VSCODE_SYSTEM_ROLE)}`,
  );

  if (messageRole !== VSCODE_SYSTEM_ROLE) {
    // Not a system message - check if it might be a disguised system prompt
    // (older behavior where system was sent as Assistant)
    if (messageRole === LanguageModelChatMessageRole.Assistant) {
      return extractDisguisedSystemPrompt(firstMessage);
    }
    return undefined;
  }

  // Extract text content from the system message
  return extractMessageText(firstMessage);
}

/**
 * Extract text content from a VS Code message.
 */
function extractMessageText(
  message: LanguageModelChatMessage,
): string | undefined {
  const content = message.content;
  let textContent = "";

  if (typeof content === "string") {
    textContent = content;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if ("value" in part && typeof part.value === "string") {
        textContent += part.value;
      }
    }
  }

  textContent = textContent.trim();
  return textContent || undefined;
}

/**
 * Detect if an Assistant message is actually a disguised system prompt.
 * This is a fallback for older VS Code versions that don't have System role.
 */
function extractDisguisedSystemPrompt(
  message: LanguageModelChatMessage,
): string | undefined {
  const textContent = extractMessageText(message);
  if (!textContent) return undefined;

  // Check for common system prompt patterns
  const systemPromptPatterns = [
    /^You are an? /i,
    /^<instructions>/i,
    /^<system>/i,
    /^As an? AI/i,
    /^Your role is/i,
    /^You're an? /i,
  ];

  for (const pattern of systemPromptPatterns) {
    if (pattern.test(textContent)) {
      logger.info(
        `[OpenResponses] Detected disguised system prompt in Assistant message`,
      );
      return textContent;
    }
  }

  // Additional heuristic: long messages with instruction keywords
  if (textContent.length > 1000) {
    const instructionKeywords = [
      "follow the user",
      "you must",
      "your task is",
      "you will be",
      "expert",
      "programming assistant",
      "coding assistant",
      "github copilot",
    ];
    const lowerContent = textContent.toLowerCase();
    const matchCount = instructionKeywords.filter((kw) =>
      lowerContent.includes(kw),
    ).length;
    if (matchCount >= 2) {
      logger.info(
        `[OpenResponses] Detected disguised system prompt via keyword heuristic`,
      );
      return textContent;
    }
  }

  return undefined;
}

/**
 * Resolve a VS Code chat message role to an OpenResponses role.
 *
 * VS Code currently exposes only User/Assistant roles. System/developer prompts
 * are supplied via options (handled as OpenResponses `instructions`).
 */
function resolveOpenResponsesRole(
  role: LanguageModelChatMessageRole,
): "user" | "assistant" {
  if (role === LanguageModelChatMessageRole.User) return "user";
  return "assistant";
}

/**
 * Extract token info from OpenResponsesError.details structured data.
 *
 * The API error response has structure like:
 * {
 *   error: {
 *     message: "Input is too long for requested model.",
 *     param: { actual_tokens?: number, max_tokens?: number, ... }
 *   }
 * }
 *
 * This gives us more reliable token counts than regex parsing.
 */
function extractTokenInfoFromDetails(
  error: unknown,
): ExtractedTokenInfo | undefined {
  if (!(error instanceof OpenResponsesError)) {
    return undefined;
  }

  const details = error.details as
    | {
        error?: {
          param?: {
            actual_tokens?: number;
            max_tokens?: number;
            token_count?: number;
            limit?: number;
          };
        };
      }
    | undefined;

  const param = details?.error?.param;
  if (!param) {
    // Log the full details to help debug what structure we're actually getting
    if (error.details) {
      logger.debug(
        `[OpenResponses] Error details structure: ${JSON.stringify(error.details)}`,
      );
    }
    return undefined;
  }

  // Try various field names that APIs might use
  const actualTokens = param.actual_tokens ?? param.token_count;
  const maxTokens = param.max_tokens ?? param.limit;

  if (typeof actualTokens === "number" && actualTokens > 0) {
    return typeof maxTokens === "number"
      ? { actualTokens, maxTokens }
      : { actualTokens };
  }

  // If we have max but not actual, estimate actual as max + 1
  if (typeof maxTokens === "number" && maxTokens > 0) {
    return {
      actualTokens: maxTokens + 1,
      maxTokens,
    };
  }

  return undefined;
}
