import { createHash } from "node:crypto";
import type { LanguageModelChatMessage } from "vscode";
import { safeJsonStringify, stripVscodeInternals } from "./serialize.js";

// Role number to string mapping
export const ROLE_NAMES: Record<number, string> = {
  1: "User",
  2: "Assistant",
  3: "System",
};

interface DigestPartOptions {
  includeCallId: boolean;
  includeName: boolean;
  includeDataDigest: boolean;
}

/**
 * Check if a string is a valid MIME type (type/subtype format).
 * Used to filter out metadata "mimeTypes" like "cache_control" that
 * VS Code/Copilot use for out-of-band signaling but aren't real content.
 *
 * Valid MIME types follow RFC 2045: type "/" subtype *(";" parameter)
 * We check for the basic type/subtype pattern.
 */
const MIME_TYPE_PATTERN = /^[a-z]+\/[a-z0-9.+-]+$/i;

function isValidMimeType(mimeType: string): boolean {
  return MIME_TYPE_PATTERN.test(mimeType);
}

/**
 * Check if a data part should be excluded from identity hashing.
 * We exclude data parts with invalid MIME types (like "cache_control")
 * since these are metadata signals, not real content, and VS Code
 * doesn't persist them across reloads.
 */
function isMetadataDataPart(
  part: LanguageModelChatMessage["content"][number],
): boolean {
  return (
    "data" in part &&
    "mimeType" in part &&
    typeof part.mimeType === "string" &&
    !isValidMimeType(part.mimeType)
  );
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").substring(0, 16);
}

function serializeToolPayload(payload: unknown): string {
  try {
    // If the payload is already a string, it might be stringified JSON.
    // We try to parse it so safeJsonStringify can re-serialize it canonically (sorted keys).
    if (typeof payload === "string") {
      try {
        const parsed = JSON.parse(payload);
        return safeJsonStringify(stripVscodeInternals(parsed));
      } catch {
        // Not JSON, use as-is but trimmed
        return payload.trim();
      }
    }
    // Strip VS Code internal properties ($mid, etc.) that change between
    // turns/sessions and break hash stability.
    return safeJsonStringify(stripVscodeInternals(payload));
  } catch {
    return "[unserializable]";
  }
}

function buildDigestPart(
  part: LanguageModelChatMessage["content"][number],
  options: DigestPartOptions,
): Record<string, unknown> {
  if ("value" in part && typeof part.value === "string") {
    return { type: "text", text: part.value };
  }
  if ("data" in part && "mimeType" in part) {
    const data = part.data;
    // For normalized digest, hash the actual data bytes
    // For raw digest, just use size (faster, sufficient for debugging)
    const dataDigest = options.includeDataDigest
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
    content: message.content
      .filter((part) => !isMetadataDataPart(part))
      .map((part) =>
        buildDigestPart(part, {
          includeCallId: false,
          includeName: false,
          includeDataDigest: true,
        }),
      ),
  };
  return hashContent(safeJsonStringify(payload));
}

/**
 * Compute a stable message hash for conversation tracking.
 *
 * Mirrors forensic capture hashing to avoid drift between
 * tracking and diagnostics.
 */
export function computeStableMessageHash(
  message: LanguageModelChatMessage,
): string {
  const parts: string[] = [];
  for (const part of message.content) {
    // Skip metadata data parts (e.g. cache_control breakpoints)
    if (isMetadataDataPart(part)) {
      continue;
    }
    if ("value" in part && typeof part.value === "string") {
      parts.push(`text:${hashContent(part.value)}`);
      continue;
    }
    if ("data" in part && "mimeType" in part) {
      const data = part.data;
      parts.push(`data:${part.mimeType}:${data.length.toString()}`);
      continue;
    }
    if ("callId" in part && "name" in part) {
      const callId = part.callId;
      const name = part.name;

      // Handle tool call (has input)
      if ("input" in part) {
        let inputHash = "";
        try {
          inputHash = hashContent(
            serializeToolPayload((part as { input?: unknown }).input),
          );
        } catch {
          inputHash = "unserializable";
        }
        parts.push(`tool:${name}:${callId}:input:${inputHash}`);
        continue;
      }

      const isResult = "toolResult" in part || "content" in part;
      let resultHash = "";
      if (isResult) {
        try {
          const safeToolResult = {
            callId,
            name,
            content:
              "content" in part
                ? String((part as { content?: unknown }).content)
                : undefined,
            toolResult:
              "toolResult" in part
                ? String((part as { toolResult?: unknown }).toolResult)
                : undefined,
          };
          resultHash = hashContent(safeJsonStringify(safeToolResult));
        } catch {
          resultHash = "unserializable";
        }
      }
      parts.push(`tool:${name}:${callId}${isResult ? `:${resultHash}` : ""}`);
      continue;
    }
    if ("callId" in part && "content" in part) {
      const callId = part.callId;
      let resultHash = "";
      try {
        const safeToolResult = {
          callId,
          content: String((part as { content?: unknown }).content),
        };
        resultHash = hashContent(safeJsonStringify(safeToolResult));
      } catch {
        resultHash = "unserializable";
      }
      parts.push(`tool:${callId}:${resultHash}`);
      continue;
    }
    if ("callId" in part && "toolResult" in part) {
      const callId = String(part.callId);
      let resultHash = "";
      try {
        const safeToolResult = {
          callId,
          toolResult: String((part as { toolResult?: unknown }).toolResult),
        };
        resultHash = hashContent(safeJsonStringify(safeToolResult));
      } catch {
        resultHash = "unserializable";
      }
      parts.push(`tool:${callId}:${resultHash}`);
    }
  }
  return hashContent(parts.join("|"));
}

/**
 * Compute a raw digest for a message, including all fields.
 *
 * Note: data parts include byte length (dataSize) instead of full binary
 * content for performance and log readability.
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
        includeDataDigest: false,
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
    includeDataDigest: false,
  });
  return hashContent(safeJsonStringify(payload));
}
