import { createHash } from "node:crypto";
import {
  LanguageModelChatMessageRole,
  type LanguageModelChatMessage,
  LanguageModelTextPart,
} from "vscode";

/**
 * Represents an agent correlation capsule embedded in message content.
 * Contains agent identity and hierarchy information.
 */
export interface Capsule {
  /** Conversation ID: stable across all turns in a conversation */
  cid: string;
  /** Agent ID: identifies the specific agent that generated this response */
  aid: string;
  /** Parent agent ID: for subagent correlation (optional) */
  pid?: string;
}

/**
 * Format a capsule as an HTML comment string.
 * Format: `<!-- v.cid:{conversationId} aid:{agentId} pid:{parentId} -->`
 *
 * @param capsule - The capsule to format
 * @returns Formatted HTML comment string
 */
export function formatCapsule(capsule: Capsule): string {
  const parts = [`v.cid:${capsule.cid}`, `aid:${capsule.aid}`];
  if (capsule.pid) {
    parts.push(`pid:${capsule.pid}`);
  }
  return `<!-- ${parts.join(" ")} -->`;
}

/**
 * Parse a capsule from an HTML comment string.
 * Expected format: `<!-- v.cid:{conversationId} aid:{agentId} pid:{parentId} -->`
 *
 * @param commentString - The HTML comment string to parse
 * @returns The parsed capsule, or null if format is invalid
 */
export function parseCapsule(commentString: string): Capsule | null {
  // Match the capsule pattern: <!-- v.cid:... aid:... [pid:...] -->
  const match = commentString.match(
    /<!-- v\.cid:(\S+) aid:(\S+)(?:\s+pid:(\S+))? -->/,
  );

  if (!match) {
    return null;
  }

  const cid = match[1]!;
  const aid = match[2]!;
  const pid = match[3];

  const capsule: Capsule = {
    cid,
    aid,
  };

  if (pid) {
    capsule.pid = pid;
  }

  return capsule;
}

/**
 * Extract a capsule from message content by looking for the HTML comment.
 * Searches for capsule at the end of the content (where it should be appended).
 *
 * @param content - The message content to search
 * @returns The parsed capsule, or null if not found
 */
export function extractCapsuleFromContent(content: string): Capsule | null {
  // Look for the capsule pattern anywhere in the content
  const commentMatch = content.match(
    /<!-- v\.cid:(\S+) aid:(\S+)(?:\s+pid:(\S+))? -->/,
  );

  if (!commentMatch) {
    return null;
  }

  const cid = commentMatch[1]!;
  const aid = commentMatch[2]!;
  const pid = commentMatch[3];

  const capsule: Capsule = {
    cid,
    aid,
  };

  if (pid) {
    capsule.pid = pid;
  }

  return capsule;
}

/**
 * Extract capsule from conversation history by scanning assistant messages.
 * Returns the most recent capsule found, or null if none exist.
 *
 * @param messages - The conversation history
 * @returns The most recent capsule, or null if not found
 */
export function extractCapsuleFromMessages(
  messages: readonly LanguageModelChatMessage[],
): Capsule | null {
  // Scan assistant messages in reverse order (most recent first)
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;

    // Only scan assistant messages
    if (message.role !== LanguageModelChatMessageRole.Assistant) {
      continue;
    }

    // Check each text part in the message
    for (const part of message.content) {
      if (part instanceof LanguageModelTextPart) {
        const capsule = extractCapsuleFromContent(part.value);
        if (capsule) {
          return capsule; // Return first (most recent) capsule found
        }
      }
    }
  }

  return null; // No capsule found in history
}

/**
 * Remove a capsule from message content (if present).
 * This is useful for cleaning up content before display.
 *
 * @param content - The message content
 * @returns Content with capsule removed (unchanged if no capsule found)
 */
export function removeCapsuleFromContent(content: string): string {
  return content.replace(
    /\s*<!-- v\.cid:\S+ aid:\S+(?:\s+pid:\S+)? -->\s*$/,
    "",
  );
}

/**
 * Append a capsule to message content.
 * Removes any existing capsule first, then appends the new one.
 *
 * @param content - The message content
 * @param capsule - The capsule to append
 * @returns Content with capsule appended
 */
export function appendCapsuleToContent(
  content: string,
  capsule: Capsule,
): string {
  // Remove existing capsule if present
  const cleaned = removeCapsuleFromContent(content);
  // Append new capsule
  return `${cleaned}\n${formatCapsule(capsule)}`;
}

/**
 * Detect if a stream buffer contains a hallucinated capsule pattern.
 * Models may attempt to generate capsules themselves based on training data.
 *
 * This looks for the start of a capsule pattern: `<!-- v.cid:`, `<!-- v.aid:`, or `<!-- v.pid:`
 *
 * @param buffer - Recent buffer from stream (typically last 20 chars)
 * @returns true if hallucinated capsule pattern detected
 */
export function detectHallucinatedCapsule(buffer: string): boolean {
  return /<!-- v\.(cid|aid|pid):/.test(buffer);
}

/**
 * Extract the last N characters from a string, useful for hallucination detection.
 * This buffer will be checked for the start of a hallucinated capsule.
 *
 * @param content - The content to extract from
 * @param n - Number of characters to extract (default: 20)
 * @returns Last n characters, or entire content if shorter
 */
export function getStreamBuffer(content: string, n: number = 20): string {
  return content.slice(Math.max(0, content.length - n));
}

/**
 * Generate a conversation ID using crypto randomness.
 * Format: `conv_{10-char-hex}`
 *
 * @returns A new conversation ID
 */
export function generateConversationId(): string {
  // Use 5 bytes of random data = 10 hex chars
  const randomBytes = createHash("sha256")
    .update(Math.random().toString() + Date.now())
    .digest("hex")
    .substring(0, 10);
  return `conv_${randomBytes}`;
}

/**
 * Generate an agent ID using crypto randomness.
 * Format: `agent_{10-char-hex}`
 *
 * @returns A new agent ID
 */
export function generateAgentId(): string {
  // Use 5 bytes of random data = 10 hex chars
  const randomBytes = createHash("sha256")
    .update(Math.random().toString() + Date.now())
    .digest("hex")
    .substring(0, 10);
  return `agent_${randomBytes}`;
}
