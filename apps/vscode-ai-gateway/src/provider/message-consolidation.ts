import type { ItemParam } from "openresponses-client";

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
export function consolidateConsecutiveMessages(
  items: ItemParam[],
): ItemParam[] {
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
