import type { LanguageModelChatMessage } from "vscode";

/**
 * Custom DataPart MIME Types
 *
 * VS Code only persists LanguageModelDataPart instances whose mimeType matches
 * one of these specific strings. This is NOT documented in the public API.
 * The strings are defined in Microsoft's vscode-copilot-chat:
 * src/platform/endpoint/common/endpointTypes.ts
 *
 * Standard MIME types like "application/..." are silently dropped.
 */
export namespace CustomDataPartMimeTypes {
  /** Anthropic prompt caching breakpoints */
  export const CacheControl = "cache_control";
  /** Session/response ID for conversation chaining */
  export const StatefulMarker = "stateful_marker";
  /** Persisted thinking/reasoning blocks */
  export const ThinkingData = "thinking";
  /** Anthropic context editing responses */
  export const ContextManagement = "context_management";
}

/**
 * @deprecated Use CustomDataPartMimeTypes.StatefulMarker instead
 */
export const STATEFUL_MARKER_MIME = CustomDataPartMimeTypes.StatefulMarker;

const STATEFUL_MARKER_EXTENSION = "sferadev.vscode-ai-gateway";

export interface StatefulMarker {
  extension: string;
  provider: string;
  modelId: string;
  sdkMode: string;
  sessionId: string;
  responseId: string;
  expireAt?: number;
}

export function isStatefulMarkerMime(mimeType: string): boolean {
  return mimeType === CustomDataPartMimeTypes.StatefulMarker;
}

/**
 * Encode a stateful marker for embedding in a LanguageModelDataPart.
 * Uses GCMP's encoding format: "modelId\JSON" where VS Code's Copilot
 * layer auto-processes the modelId prefix before the backslash.
 */
export function encodeStatefulMarker(
  modelId: string,
  marker: Omit<StatefulMarker, "extension">,
): Uint8Array {
  return new TextEncoder().encode(
    `${modelId}\\${JSON.stringify({ ...marker, extension: STATEFUL_MARKER_EXTENSION })}`,
  );
}

/**
 * Decode a stateful marker from a LanguageModelDataPart.
 * Handles GCMP's "modelId\JSON" encoding format.
 */
export function decodeStatefulMarker(
  data: Uint8Array,
): { modelId: string; marker: StatefulMarker } | undefined {
  try {
    const decoded = new TextDecoder().decode(data);
    const backslashIdx = decoded.indexOf("\\");
    if (backslashIdx === -1) return undefined;
    const parsedModelId = decoded.substring(0, backslashIdx);
    const markerStr = decoded.substring(backslashIdx + 1);
    const marker = JSON.parse(markerStr) as StatefulMarker;
    if (!marker.responseId || !marker.extension) return undefined;
    return { modelId: parsedModelId, marker };
  } catch {
    return undefined;
  }
}

export function findLatestStatefulMarker(
  messages: readonly LanguageModelChatMessage[],
  _modelId: string,
): StatefulMarker | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 2) {
      continue;
    }
    for (const part of message.content) {
      if (
        "data" in part &&
        "mimeType" in part &&
        typeof part.mimeType === "string" &&
        isStatefulMarkerMime(part.mimeType)
      ) {
        const data = part.data as Uint8Array;
        const decoded = decodeStatefulMarker(data);
        if (!decoded) {
          continue;
        }
        // Only match markers from our extension
        if (decoded.marker.extension !== STATEFUL_MARKER_EXTENSION) {
          continue;
        }
        return decoded.marker;
      }
    }
  }
  return undefined;
}
