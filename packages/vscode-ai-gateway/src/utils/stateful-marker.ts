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
 * Check if a DataPart MIME type is "metadata" — i.e. it carries internal
 * state that should be excluded from token counting, digest hashing, and
 * message translation to the upstream API.
 *
 * Currently covers `stateful_marker` and `thinking` MIME types.
 */
export function isMetadataMime(mimeType: string): boolean {
  return (
    mimeType === CustomDataPartMimeTypes.StatefulMarker ||
    mimeType === CustomDataPartMimeTypes.ThinkingData
  );
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

// ============================================================================
// ThinkingData Encode/Decode
// ============================================================================

/**
 * Persisted thinking data, matching Microsoft's ThinkingData shape.
 * See: vscode-copilot-chat/src/platform/thinking/common/thinking.ts
 */
export interface ThinkingData {
  id: string;
  text: string | string[];
  metadata?: { [key: string]: unknown };
  tokens?: number;
}

/**
 * The opaque container format used for DataPart('thinking') persistence.
 * Matches Microsoft's ThinkingDataContainer output shape.
 */
interface ThinkingDataContainer {
  type: typeof CustomDataPartMimeTypes.ThinkingData;
  thinking: ThinkingData;
}

/**
 * Encode ThinkingData for embedding in a DataPart('thinking').
 * Produces the same shape as Microsoft's ThinkingDataContainer:
 *   { type: 'thinking', thinking: ThinkingData }
 */
export function encodeThinkingData(thinking: ThinkingData): Uint8Array {
  const container: ThinkingDataContainer = {
    type: CustomDataPartMimeTypes.ThinkingData,
    thinking,
  };
  return new TextEncoder().encode(JSON.stringify(container));
}

/**
 * Decode a DataPart('thinking') payload back to ThinkingData.
 * Performs type-checking on the `type` field to validate the container.
 */
export function decodeThinkingData(
  data: Uint8Array,
): ThinkingData | undefined {
  try {
    const decoded = new TextDecoder().decode(data);
    const parsed: unknown = JSON.parse(decoded);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("type" in parsed) ||
      !("thinking" in parsed)
    ) {
      return undefined;
    }
    const container = parsed as ThinkingDataContainer;
    if (
      container.type !== CustomDataPartMimeTypes.ThinkingData ||
      !container.thinking ||
      typeof container.thinking !== "object"
    ) {
      return undefined;
    }
    return container.thinking;
  } catch {
    return undefined;
  }
}

/**
 * Find all ThinkingData from DataPart('thinking') in assistant messages.
 * Returns them in order of appearance.
 */
export function findThinkingData(
  messages: readonly LanguageModelChatMessage[],
): ThinkingData[] {
  const results: ThinkingData[] = [];
  for (const message of messages) {
    if (message.role !== 2) {
      continue;
    }
    for (const part of message.content) {
      if (
        "data" in part &&
        "mimeType" in part &&
        typeof part.mimeType === "string" &&
        part.mimeType === CustomDataPartMimeTypes.ThinkingData
      ) {
        const data = part.data as Uint8Array;
        const thinking = decodeThinkingData(data);
        if (thinking) {
          results.push(thinking);
        }
      }
    }
  }
  return results;
}
