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

export interface ExtractIdentityOptions {
  modelId?: string;
}

const conversationCache = new Map<string, string>();

/**
 * Derive a stable conversation identity.
 * Uses model ID and first user message hash when available.
 */
export function extractIdentity(
  messages: readonly LanguageModelChatMessage[],
  options?: ExtractIdentityOptions,
): ExtractedIdentity {
  const firstUserText = getFirstUserMessageText(messages);
  const firstUserHash = firstUserText
    ? hashUserMessage(firstUserText)
    : "no-user";
  const key = [options?.modelId ?? "no-model", firstUserHash].join("|");

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

/**
 * Type guard for text-like parts (either LanguageModelTextPart or serialized {type, text}).
 * VS Code may serialize message parts as plain objects instead of class instances.
 */
function isTextPart(
  part: unknown,
): part is LanguageModelTextPart | { type: "text"; text: string } {
  if (part instanceof LanguageModelTextPart) return true;
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    (part as { type: unknown }).type === "text" &&
    "text" in part &&
    typeof (part as { text: unknown }).text === "string"
  );
}

/**
 * Extract text value from a text-like part.
 */
function getTextValue(
  part: LanguageModelTextPart | { type: "text"; text: string },
): string {
  if (part instanceof LanguageModelTextPart) {
    return part.value;
  }
  return part.text;
}

function getFirstUserMessageText(
  messages: readonly LanguageModelChatMessage[],
): string | null {
  for (const message of messages) {
    if (message.role !== LanguageModelChatMessageRole.User) {
      continue;
    }

    const textParts = Array.from(message.content).filter(isTextPart) as Array<
      LanguageModelTextPart | { type: "text"; text: string }
    >;
    const parts = textParts.map(getTextValue).join("");

    return parts.length > 0 ? parts : null;
  }

  return null;
}
