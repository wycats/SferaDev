import { createHash } from "node:crypto";
import type { LanguageModelChatMessage } from "vscode";
import { safeJsonStringify } from "./serialize.js";

// Role number to string mapping
export const ROLE_NAMES: Record<number, string> = {
  1: "User",
  2: "Assistant",
  3: "System",
};

type DigestPartOptions = {
  includeCallId: boolean;
  includeName: boolean;
  stripAdditions: boolean;
};

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").substring(0, 16);
}

function serializeToolPayload(payload: unknown): string {
  try {
    return safeJsonStringify(payload);
  } catch {
    return "[unserializable]";
  }
}

/**
 * Strip additions we add during output streaming:
 * - URL annotations: ` [title](url)` markdown links
 *
 * Per digest-equivalence-algebra.md Section 6:
 * stripOurAdditions(text) = stripUrlAnnotations(text)
 *
 * @visibleForTesting
 */
export function stripOurAdditions(text: string): string {
  // Strip URL annotations formatted as ` [title](url)`
  // The annotation format from stream-adapter.ts: ` [${title}](${url})`
  // Pattern: space followed by markdown link
  const stripped = text.replace(/ \[[^\]]+\]\([^)]+\)/g, "");
  return stripped;
}

function buildDigestPart(
  part: LanguageModelChatMessage["content"][number],
  options: DigestPartOptions,
): Record<string, unknown> {
  if ("value" in part && typeof part.value === "string") {
    const text = options.stripAdditions
      ? stripOurAdditions(part.value)
      : part.value;
    return { type: "text", text };
  }
  if ("data" in part && "mimeType" in part) {
    const data = part.data;
    // For normalized digest, hash the actual data bytes
    // For raw digest, just use size (faster, sufficient for debugging)
    const dataDigest = options.stripAdditions
      ? hashContent(Buffer.from(data).toString("base64"))
      : undefined;
    return {
      type: "data",
      mimeType: part.mimeType,
      ...(dataDigest !== undefined
        ? { dataDigest }
        : { dataSize: data.length }),
    };
  }
  // Handle tool call parts (have name and input)
  if ("callId" in part && "name" in part && "input" in part) {
    const base: Record<string, unknown> = {
      type: "toolCall",
      toolName: part.name,
    };
    if (options.includeCallId) {
      base["callId"] = part.callId;
    }
    base["input"] = serializeToolPayload((part as { input?: unknown }).input);
    return base;
  }
  // Handle tool result parts (VS Code API: callId + content)
  if ("callId" in part && "content" in part) {
    const base: Record<string, unknown> = {
      type: "toolResult",
    };
    if (options.includeCallId) {
      base["callId"] = part.callId;
    }
    base["content"] = serializeToolPayload(
      (part as { content?: unknown }).content,
    );
    return base;
  }
  // Handle legacy tool result format (callId + toolResult)
  if ("callId" in part && "toolResult" in part) {
    const base: Record<string, unknown> = {
      type: "toolResult",
    };
    if (options.includeCallId) {
      base["callId"] = part.callId;
    }
    if ("name" in part) {
      base["toolName"] = part.name;
    }
    base["toolResult"] = serializeToolPayload(
      (part as { toolResult?: unknown }).toolResult,
    );
    return base;
  }
  return { type: "unknown" };
}

/**
 * Compute a normalized digest for a message, excluding unstable fields.
 * Used to verify A1-A4 assumptions.
 *
 * Normalization rules (from digest-equivalence-algebra.md):
 * - EXCLUDE: name field (often empty/unreliable)
 * - EXCLUDE: callId on tool parts (may be unstable)
 * - Include: role, content text, tool names, tool inputs/results
 */
export function computeNormalizedDigest(
  message: LanguageModelChatMessage,
): string {
  const payload = {
    role:
      ROLE_NAMES[message.role as number] ?? `Unknown(${String(message.role)})`,
    content: message.content.map((part) =>
      buildDigestPart(part, {
        includeCallId: false,
        includeName: false,
        stripAdditions: true,
      }),
    ),
  };
  return hashContent(safeJsonStringify(payload));
}

/**
 * Compute a raw digest for a message, including all fields.
 */
export function computeRawDigest(message: LanguageModelChatMessage): string {
  const name = (message as { name?: string }).name;
  const payload = {
    role:
      ROLE_NAMES[message.role as number] ?? `Unknown(${String(message.role)})`,
    ...(name !== undefined ? { name } : {}),
    content: message.content.map((part) =>
      buildDigestPart(part, {
        includeCallId: true,
        includeName: true,
        stripAdditions: false,
      }),
    ),
  };
  return hashContent(safeJsonStringify(payload));
}

export function computePartDigest(
  part: LanguageModelChatMessage["content"][number],
): string {
  const payload = buildDigestPart(part, {
    includeCallId: true,
    includeName: true,
    stripAdditions: false,
  });
  return hashContent(safeJsonStringify(payload));
}
