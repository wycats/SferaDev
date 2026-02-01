/**
 * Message Translation
 *
 * Translates VS Code LanguageModelChatMessage instances to OpenResponses API format.
 * Handles all VS Code part types:
 * - LanguageModelTextPart → input_text/output_text
 * - LanguageModelDataPart → input_file (for images - see WORKAROUND below)
 * - LanguageModelToolCallPart → function_call
 * - LanguageModelToolResultPart → function_call_output
 *
 * WORKAROUND: We use input_file instead of input_image for images because
 * the gateway hardcodes mediaType: 'image/*' for input_image, which Anthropic
 * rejects. input_file uses inferMediaType() which extracts the MIME from the
 * data URL. See: packages/openresponses-client/IMPLEMENTATION_CONSTRAINTS.md
 */

import type {
  FunctionCallItemParam,
  FunctionCallOutputItemParam,
  InputFileContentParam,
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
 * Special tokens used by various language models that must be stripped from input.
 * These tokens cause API errors like "The text contains a special token that is not allowed".
 *
 * Common special tokens:
 * - <|endoftext|> - GPT models end-of-sequence
 * - <|im_start|>, <|im_end|> - ChatML format markers
 * - <|fim_prefix|>, <|fim_middle|>, <|fim_suffix|> - Fill-in-the-middle tokens
 * - <|pad|> - Padding token
 * - <|sep|> - Separator token
 * - <|startoftext|> - Start of text marker
 */
const SPECIAL_TOKEN_PATTERN =
  /<\|(endoftext|im_start|im_end|fim_prefix|fim_middle|fim_suffix|pad|sep|startoftext|eot_id|start_header_id|end_header_id|python_tag|eom_id|finetune_right_pad_id)\|>/gi;

/**
 * Sanitize text content by removing special model tokens.
 * These tokens can appear in tool outputs or other content that includes raw model output.
 */
export function sanitizeSpecialTokens(text: string): string {
  const sanitized = text.replace(SPECIAL_TOKEN_PATTERN, "");
  if (sanitized !== text) {
    logger.debug(
      `[OpenResponses] Stripped special tokens from text (${text.length} → ${sanitized.length} chars)`,
    );
  }
  return sanitized;
}

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
 * Translate a single VS Code message to OpenResponses items.
 */
export function translateMessage(
  message: LanguageModelChatMessage,
): ItemParam[] {
  const items: ItemParam[] = [];
  const role = message.role;
  const openResponsesRole = resolveOpenResponsesRole(role);

  logger.trace(
    `[OpenResponses] translateMessage role=${String(role)} mapped=${openResponsesRole}`,
  );

  // Collect content parts
  // Note: We use input_file for images due to gateway bug with input_image
  // (gateway hardcodes mediaType: 'image/*' which Anthropic rejects)
  type UserContent =
    | InputTextContentParam
    | InputImageContentParamAutoParam
    | InputFileContentParam;
  type AssistantContent = OutputTextContentParam;
  const contentParts: (UserContent | AssistantContent)[] = [];

  for (const part of message.content) {
    if (part instanceof LanguageModelTextPart) {
      // Sanitize special tokens that may appear in tool outputs
      const sanitizedText = sanitizeSpecialTokens(part.value);
      // Use input_text for User role, output_text for Assistant
      if (openResponsesRole === "assistant") {
        contentParts.push({
          type: "output_text",
          text: sanitizedText,
        });
      } else {
        contentParts.push({
          type: "input_text",
          text: sanitizedText,
        });
      }
    } else if (part instanceof LanguageModelDataPart) {
      // Binary data - images
      if (part.mimeType.startsWith("image/") && openResponsesRole === "user") {
        const base64 = Buffer.from(part.data).toString("base64");
        // Resolve the actual mime type - VS Code may pass "image/*" wildcard
        // which the API rejects. Detect from magic bytes if needed.
        const resolvedMimeType = detectImageMimeType(part.data, part.mimeType);
        // WORKAROUND: Use input_file instead of input_image because the gateway
        // hardcodes mediaType: 'image/*' for input_image, which Anthropic rejects.
        // input_file uses inferMediaType() which extracts the MIME from the data URL.
        // See: packages/openresponses-client/IMPLEMENTATION_CONSTRAINTS.md
        const dataUrl = `data:${resolvedMimeType};base64,${base64}`;
        contentParts.push({
          type: "input_file",
          file_data: dataUrl,
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
      // Note: part.input may be undefined at runtime despite types
      const inputValue: unknown = part.input;
      const functionCallItem: FunctionCallItemParam = {
        type: "function_call",
        call_id: part.callId,
        name: part.name,
        arguments:
          typeof inputValue === "string"
            ? inputValue
            : JSON.stringify(inputValue ?? {}),
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
    | InputFileContentParam
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

  // Mixed content (has images/files) - only user messages support this
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
        | InputFileContentParam
      )[],
    };
  }

  // Assistant/developer with mixed content (shouldn't happen) → fallback to text
  const text = joinText();
  return text ? ({ type: "message", role, content: text } as ItemParam) : null;
}
