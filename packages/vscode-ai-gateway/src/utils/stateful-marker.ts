import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LanguageModelChatMessage } from "vscode";

/**
 * MIME type for stateful markers. Must match GCMP's convention exactly:
 * VS Code only persists DataParts with specific simple MIME types
 * (e.g. "cache_control", "stateful_marker", "thinking").
 * Standard MIME types like "application/..." are silently dropped.
 */
export const STATEFUL_MARKER_MIME = "stateful_marker";

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

export interface StatefulMarkerLogEvent {
  type: "emit" | "use";
  timestamp?: string;
  modelId?: string;
  responseId?: string;
  previousResponseId?: string;
  chatId?: string;
}

export function isStatefulMarkerMime(mimeType: string): boolean {
  return mimeType === STATEFUL_MARKER_MIME;
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

export function logStatefulMarkerEvent(event: StatefulMarkerLogEvent): void {
  try {
    const entry = {
      timestamp: event.timestamp ?? new Date().toISOString(),
      type: event.type,
      modelId: event.modelId,
      responseId: event.responseId,
      previousResponseId: event.previousResponseId,
      chatId: event.chatId,
    };
    const dir = path.join(os.homedir(), ".vscode-ai-gateway");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "stateful-marker.jsonl"),
      `${JSON.stringify(entry)}\n`,
    );
  } catch {
    // Never let logging affect request flow.
  }
}
