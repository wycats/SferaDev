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
  _toolNameMap: Map<string, string>,
): ItemParam[] {
  void _toolNameMap;
  const items: ItemParam[] = [];
  const role = message.role;
  const openResponsesRole = resolveOpenResponsesRole(role);

  // DEBUG: Log the incoming role
  logger.trace(
    `[OpenResponses] translateMessage role=${String(role)} (User=${String(LanguageModelChatMessageRole.User)}, Assistant=${String(LanguageModelChatMessageRole.Assistant)}) mapped=${openResponsesRole}`,
  );

  // Collect content parts
  type UserContent = InputTextContentParam | InputImageContentParamAutoParam;
  type AssistantContent = OutputTextContentParam;
  const contentParts: (UserContent | AssistantContent)[] = [];

  for (const part of message.content) {
    if (part instanceof LanguageModelTextPart) {
      // Text content
      // Use input_text for User role, and also for unknown roles (which become user messages)
      // Only use output_text for Assistant role
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
  // Convert content array to string
  // For text-only content: concatenate all text parts
  // For mixed content (text + images): use array format (but this is rare)

  // Check if content is text-only
  const textOnly = content.every(
    (part) => part.type === "input_text" || part.type === "output_text",
  );

  if (textOnly) {
    // Concatenate all text parts into a single string
    const textContent = content
      .map((part) => ("text" in part ? part.text : ""))
      .join("");
    if (textContent.trim() === "") {
      return null;
    }

    return {
      type: "message",
      role,
      content: textContent,
    } as ItemParam;
  }

  // For mixed content (has images), keep as array
  // This is mainly for user messages with images
  switch (role) {
    case "user": {
      // For user with mixed content, keep the array but filter empty items
      const filteredContent = content.filter((part) => {
        if ("text" in part) return part.text.length > 0;
        return true; // Keep images
      });
      if (filteredContent.length === 0) {
        return null;
      }
      return {
        type: "message",
        role: "user",
        content: filteredContent as (
          | InputTextContentParam
          | InputImageContentParamAutoParam
        )[],
      };
    }

    case "assistant": {
      // Assistant should never have images, so this shouldn't happen
      // But if it does, convert to text
      const assText = content
        .map((part) => ("text" in part ? part.text : ""))
        .join("");
      if (assText.trim() === "") {
        return null;
      }
      return {
        type: "message",
        role: "assistant",
        content: assText,
      };
    }

    case "developer": {
      // Developer messages are typically text-only
      const devText = content
        .map((part) => ("text" in part ? part.text : ""))
        .join("");
      if (devText.trim() === "") {
        return null;
      }
      return {
        type: "message",
        role: "developer",
        content: devText,
      };
    }
  }
}
