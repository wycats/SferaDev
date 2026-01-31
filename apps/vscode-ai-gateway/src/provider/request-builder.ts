/**
 * Request Builder
 *
 * Translates VS Code chat requests to OpenResponses API format.
 * Orchestrates the translation pipeline: system prompt extraction,
 * message translation, consolidation, and tool conversion.
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
import { translateMessage } from "./message-translation.js";
import { extractSystemPrompt } from "./system-prompt.js";

/**
 * Result of translating a VS Code chat request to OpenResponses format.
 */
export interface TranslateRequestResult {
  input: ItemParam[];
  instructions?: string;
  tools: FunctionToolParam[];
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

  // Handle VS Code System role (proposed API): VS Code Copilot sends the system
  // prompt using role=3 (System). We extract it and use the `instructions` field.
  let messagesToProcess = messages;
  const systemPromptFromMessages = extractSystemPrompt(messages);
  if (systemPromptFromMessages) {
    logger.info(
      `[OpenResponses] Extracted system prompt (${systemPromptFromMessages.length} chars) from VS Code System role`,
    );
    instructions = systemPromptFromMessages;
    messagesToProcess = messages.slice(1);
  }

  // Convert each message
  for (const message of messagesToProcess) {
    input.push(...translateMessage(message));
  }

  // Filter out empty messages to prevent API 400 errors
  const validInput = input.filter((item) => {
    if (item.type !== "message") return true;
    const msg = item as { content?: string | unknown[] };
    if (typeof msg.content === "string") return msg.content.length > 0;
    if (Array.isArray(msg.content)) return msg.content.length > 0;
    return true;
  });

  if (validInput.length !== input.length) {
    logger.warn(`[OpenResponses] Filtered ${input.length - validInput.length} empty message(s)`);
  }

  // Consolidate consecutive same-role messages for Claude compatibility
  // See: packages/openresponses-client/IMPLEMENTATION_CONSTRAINTS.md
  const consolidatedInput = consolidateConsecutiveMessages(validInput);
  if (consolidatedInput.length !== validInput.length) {
    logger.info(`[OpenResponses] Consolidated ${validInput.length} → ${consolidatedInput.length} messages`);
  }

  // Prepend developer message for non-OpenAI providers (they ignore `instructions` field)
  let finalInput = consolidatedInput;
  if (instructions) {
    const developerMessage: ItemParam = {
      type: "message",
      role: "developer",
      content: instructions,
    };
    finalInput = [developerMessage, ...consolidatedInput];
    logger.info(`[OpenResponses] Prepended developer message (${instructions.length} chars)`);
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
