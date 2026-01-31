/**
 * Request Builder
 *
 * Translates VS Code chat requests to OpenResponses API format.
 * Orchestrates the full translation pipeline:
 * - System prompt extraction and injection
 * - Message translation via message-translation.ts
 * - Message consolidation for Claude compatibility
 * - Tool conversion to OpenResponses format
 */

import type { FunctionToolParam, ItemParam } from "openresponses-client";
import {
  type LanguageModelChatMessage,
  LanguageModelChatToolMode,
  type ProvideLanguageModelChatResponseOptions,
} from "vscode";
import type { ConfigService } from "../config.js";
import { logger } from "../logger.js";
import { consolidateConsecutiveMessages } from "./message-consolidation.js";
import { buildToolNameMap, translateMessage } from "./message-translation.js";
import { extractSystemPrompt } from "./system-prompt.js";

/**
 * Result of translating a VS Code chat request to OpenResponses format.
 */
export interface TranslateRequestResult {
  /** Translated input items for the API */
  input: ItemParam[];
  /** System/developer instructions (if any) */
  instructions?: string;
  /** Converted tool definitions */
  tools: FunctionToolParam[];
  /** Tool choice mode */
  toolChoice: "auto" | "required" | "none";
}

/**
 * Translate a VS Code chat request to OpenResponses format.
 */
export function translateRequest(
  messages: readonly LanguageModelChatMessage[],
  options: ProvideLanguageModelChatResponseOptions,
  configService: ConfigService,
): TranslateRequestResult {
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
    // NOTE: The API requires message content to be a STRING, not an array.
    // See: packages/openresponses-client/IMPLEMENTATION_CONSTRAINTS.md
    const developerMessage: ItemParam = {
      type: "message",
      role: "developer",
      content: instructions,
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
