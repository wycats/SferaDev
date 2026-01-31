/**
 * Message Translation
 *
 * Translates VS Code LanguageModelChatMessage instances to OpenResponses API format.
 * Handles all VS Code part types:
 * - LanguageModelTextPart → input_text/output_text
 * - LanguageModelDataPart → input_image (for images)
 * - LanguageModelToolCallPart → function_call
 * - LanguageModelToolResultPart → function_call_output
 */

import type {
  FunctionCallItemParam,
  FunctionCallOutputItemParam,
  InputImageContentParamAutoParam,
  InputTextContentParam,
  ItemParam,
  OutputTextContentParam,
} from "openresponses-client";
import {
  type LanguageModelChatMessage,
  LanguageModelChatMessageRole,
  LanguageModelDataPart,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
} from "vscode";
import { logger } from "../logger.js";
import { detectImageMimeType } from "./image-utils.js";

/**
 * Resolve a VS Code chat message role to an OpenResponses role.
 *
 * VS Code currently exposes only User/Assistant roles. System/developer prompts
 * are supplied via options (handled as OpenResponses `instructions`).
 */
export function resolveOpenResponsesRole(
  role: LanguageModelChatMessageRole,
): "user" | "assistant" {
  if (role === LanguageModelChatMessageRole.User) return "user";
  return "assistant";
}

/**
 * Build a mapping of tool call IDs to tool names.
 */
export function buildToolNameMap(
  messages: readonly LanguageModelChatMessage[],
): Map<string, string> {
  const map = new Map<string, string>();

  for (const message of messages) {
    for (const part of message.content) {
      if (part instanceof LanguageModelToolCallPart) {
        map.set(part.callId, part.name);
      }
    }
  }

  return map;
}

/**
 * Translate a single VS Code message to OpenResponses items.
 */
export function translateMessage(
  message: LanguageModelChatMessage,
): ItemParam[] {
  const items: ItemParam[] = [];
  const role = message.role;
  const openResponsesRole = resolveOpenResponsesRole(role);

  logger.trace(
    `[OpenResponses] translateMessage role=${role} mapped=${openResponsesRole}`,
  );

  // Collect content parts
  type UserContent = InputTextContentParam | InputImageContentParamAutoParam;
  type AssistantContent = OutputTextContentParam;
  const contentParts: (UserContent | AssistantContent)[] = [];

  for (const part of message.content) {
    if (part instanceof LanguageModelTextPart) {
      // Use input_text for User role, output_text for Assistant
      if (openResponsesRole === "assistant") {
        contentParts.push({
          type: "output_text",
          text: part.value,
        });
      } else {
        contentParts.push({
          type: "input_text",
          text: part.value,
        });
      }
    } else if (part instanceof LanguageModelDataPart) {
      // Binary data - images
      if (part.mimeType.startsWith("image/") && openResponsesRole === "user") {
        const base64 = Buffer.from(part.data).toString("base64");
        // Resolve the actual mime type - VS Code may pass "image/*" wildcard
        // which the API rejects. Detect from magic bytes if needed.
        const resolvedMimeType = detectImageMimeType(part.data, part.mimeType);
        const imageUrl = `data:${resolvedMimeType};base64,${base64}`;
        contentParts.push({
          type: "input_image",
          image_url: imageUrl,
        });
      }
    } else if (part instanceof LanguageModelToolCallPart) {
      // Emit function_call item for tool calls.
      // The gateway now accepts function_call as input (verified 2026-01-31).
      // See: packages/openresponses-client/IMPLEMENTATION_CONSTRAINTS.md
      //
      // First, flush any accumulated content
      if (contentParts.length > 0) {
        const messageItem = createMessageItem(openResponsesRole, contentParts);
        if (messageItem) {
          items.push(messageItem);
        }
        contentParts.length = 0;
      }

      // Emit function_call item
      const functionCallItem: FunctionCallItemParam = {
        type: "function_call",
        call_id: part.callId,
        name: part.name,
        arguments:
          typeof part.input === "string"
            ? part.input
            : JSON.stringify(part.input ?? {}),
      };
      items.push(functionCallItem as ItemParam);
    } else if (part instanceof LanguageModelToolResultPart) {
      // Emit function_call_output item for tool results.
      // This MUST follow a corresponding function_call item with matching call_id.
      // See: packages/openresponses-client/IMPLEMENTATION_CONSTRAINTS.md
      //
      // First, flush any accumulated content
      if (contentParts.length > 0) {
        const messageItem = createMessageItem(openResponsesRole, contentParts);
        if (messageItem) {
          items.push(messageItem);
        }
        contentParts.length = 0;
      }

      const output =
        typeof part.content === "string"
          ? part.content
          : JSON.stringify(part.content);
      if (output.trim() === "") {
        logger.debug("[OpenResponses] Skipping empty tool result content");
        continue;
      }

      // Emit function_call_output item
      const functionCallOutputItem: FunctionCallOutputItemParam = {
        type: "function_call_output",
        call_id: part.callId,
        output,
      };
      items.push(functionCallOutputItem as ItemParam);
    }
  }

  // Flush remaining content
  if (contentParts.length > 0) {
    const messageItem = createMessageItem(openResponsesRole, contentParts);
    if (messageItem) {
      items.push(messageItem);
    }
  }

  return items;
}

/**
 * Create a message item from content parts.
 *
 * NOTE: We deliberately omit "system" role here. The OpenResponses API rejects
 * `role: "system"` in input messages. Use the `instructions` field for system
 * prompts, or use "developer" role for message-based system-like content.
 *
 * CRITICAL: The Vercel AI Gateway/OpenResponses API requires message content
 * to be a STRING, not an array of content objects. If content is structured
 * as an array, the API returns 400 Invalid input.
 */
export function createMessageItem(
  role: "user" | "assistant" | "developer",
  content: (
    | InputTextContentParam
    | InputImageContentParamAutoParam
    | OutputTextContentParam
  )[],
): ItemParam | null {
  // Helper to extract and join text from content parts
  const joinText = () =>
    content
      .map((part) => ("text" in part ? part.text : ""))
      .join("")
      .trim();

  // Text-only content → single string
  const textOnly = content.every(
    (part) => part.type === "input_text" || part.type === "output_text",
  );

  if (textOnly) {
    const text = joinText();
    return text
      ? ({ type: "message", role, content: text } as ItemParam)
      : null;
  }

  // Mixed content (has images) - only user messages support this
  if (role === "user") {
    const filtered = content.filter((part) =>
      "text" in part ? part.text.length > 0 : true,
    );
    if (filtered.length === 0) return null;
    return {
      type: "message",
      role: "user",
      content: filtered as (
        | InputTextContentParam
        | InputImageContentParamAutoParam
      )[],
    };
  }

  // Assistant/developer with mixed content (shouldn't happen) → fallback to text
  const text = joinText();
  return text ? ({ type: "message", role, content: text } as ItemParam) : null;
}
