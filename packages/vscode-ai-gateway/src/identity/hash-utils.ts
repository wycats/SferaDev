import { createHash } from "node:crypto";

/**
 * Compute a stable hash of the tool set.
 * Sorts tools by name to ensure stability regardless of order.
 * Accepts any tool-like object with a name property.
 */
export function computeToolSetHash(tools: readonly { name: string }[]): string {
  const sortedNames = tools.map((t) => t.name).sort();
  const encodedNames = sortedNames.map((name) => `${name.length}:${name}`);
  return createHash("sha256")
    .update(encodedNames.join("|"))
    .digest("hex")
    .substring(0, 16);
}

/**
 * Compute the agent type hash from the tool set hash.
 */
export function computeAgentTypeHash(toolSetHash: string): string {
  return toolSetHash.substring(0, 16);
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
