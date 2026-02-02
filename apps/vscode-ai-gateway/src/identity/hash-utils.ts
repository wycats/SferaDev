import { createHash } from "node:crypto";

/**
 * Compute a stable hash of the tool set.
 * Sorts tools by name to ensure stability regardless of order.
 * Accepts any tool-like object with a name property.
 */
export function computeToolSetHash(tools: readonly { name: string }[]): string {
  const sortedNames = tools.map((t) => t.name).sort();
  return createHash("sha256")
    .update(sortedNames.join("|"))
    .digest("hex")
    .substring(0, 16);
}

/**
 * Compute the agent type hash from system prompt and tool set.
 */
export function computeAgentTypeHash(
  systemPromptHash: string,
  toolSetHash: string,
): string {
  return createHash("sha256")
    .update(systemPromptHash + toolSetHash)
    .digest("hex")
    .substring(0, 16);
}

/**
 * Compute the conversation instance hash.
 * Called after first assistant response is received.
 */
export function computeConversationHash(
  agentTypeHash: string,
  firstUserMessageHash: string,
  firstAssistantResponseHash: string,
): string {
  return createHash("sha256")
    .update(agentTypeHash + firstUserMessageHash + firstAssistantResponseHash)
    .digest("hex")
    .substring(0, 16);
}

/**
 * Canonicalize and hash the first assistant response.
 * - Extract first text content only
 * - Truncate to 500 characters
 * - Trim whitespace
 */
export function hashFirstAssistantResponse(textContent: string): string {
  const canonical = textContent.trim().substring(0, 500);
  return createHash("sha256").update(canonical).digest("hex").substring(0, 16);
}

/**
 * Hash a user message for conversation identity.
 */
export function hashUserMessage(text: string): string {
  return createHash("sha256")
    .update(text.trim())
    .digest("hex")
    .substring(0, 16);
}
