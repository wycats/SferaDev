import type { LanguageModelChatMessage } from "vscode";
import { LanguageModelChatMessageRole } from "vscode";
import { logger } from "../logger.js";

/**
 * VS Code proposed API: LanguageModelChatMessageRole.System = 3
 * See: vscode.proposed.languageModelSystem.d.ts
 * This is used by VS Code Copilot to send system prompts.
 */
export const VSCODE_SYSTEM_ROLE = 3;

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
export function extractSystemPrompt(
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
export function extractMessageText(
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
export function extractDisguisedSystemPrompt(
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
