import { createHash } from "node:crypto";
import {
  type LanguageModelChatMessage,
  LanguageModelChatMessageRole,
  LanguageModelTextPart,
} from "vscode";
import { hashUserMessage } from "./hash-utils.js";

export interface ExtractedIdentity {
  conversationId: string;
}

const conversationCache = new Map<string, string>();

/**
 * Derive a stable conversation identity without capsule extraction.
 * Uses the system prompt hash, model ID, and first user message hash when available.
 */
export function extractIdentity(
  messages: readonly LanguageModelChatMessage[],
  options?: { systemPromptHash?: string; modelId?: string },
): ExtractedIdentity {
  const firstUserText = getFirstUserMessageText(messages);
  const firstUserHash = firstUserText
    ? hashUserMessage(firstUserText)
    : "no-user";
  const key = [
    options?.systemPromptHash ?? "no-system",
    options?.modelId ?? "no-model",
    firstUserHash,
  ].join("|");

  let conversationId = conversationCache.get(key);
  if (!conversationId) {
    conversationId = generateConversationId(key);
    conversationCache.set(key, conversationId);
  }

  return { conversationId };
}

export function generateConversationId(seed?: string): string {
  const source = seed ?? `${Math.random()}${Date.now()}`;
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 10);
  return `conv_${hash}`;
}

function getFirstUserMessageText(
  messages: readonly LanguageModelChatMessage[],
): string | null {
  for (const message of messages) {
    if (message.role !== LanguageModelChatMessageRole.User) {
      continue;
    }

    const parts = Array.from(message.content)
      .filter((part) => part instanceof LanguageModelTextPart)
      .map((part) => part.value)
      .join("");

    return parts.length > 0 ? parts : null;
  }

  return null;
}
