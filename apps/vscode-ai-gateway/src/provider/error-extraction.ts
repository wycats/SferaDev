/**
 * Error Extraction
 *
 * Utilities for extracting structured information from OpenResponses API errors.
 * Primarily used for token count extraction from "input too long" errors.
 */

import { OpenResponsesError } from "openresponses-client";
import { type ExtractedTokenInfo, logger } from "../logger.js";

/**
 * Extract token info from OpenResponsesError.details structured data.
 *
 * The API error response has structure like:
 * {
 *   error: {
 *     message: "Input is too long for requested model.",
 *     param: { actual_tokens?: number, max_tokens?: number, ... }
 *   }
 * }
 *
 * This gives us more reliable token counts than regex parsing.
 */
export function extractTokenInfoFromDetails(
  error: unknown,
): ExtractedTokenInfo | undefined {
  if (!(error instanceof OpenResponsesError)) {
    return undefined;
  }

  const details = error.details as
    | {
        error?: {
          param?: {
            actual_tokens?: number;
            max_tokens?: number;
            token_count?: number;
            limit?: number;
          };
        };
      }
    | undefined;

  const param = details?.error?.param;
  if (!param) {
    // Log the full details to help debug what structure we're actually getting
    if (error.details) {
      logger.debug(
        `[OpenResponses] Error details structure: ${JSON.stringify(error.details)}`,
      );
    }
    return undefined;
  }

  // Try various field names that APIs might use
  const actualTokens = param.actual_tokens ?? param.token_count;
  const maxTokens = param.max_tokens ?? param.limit;

  if (typeof actualTokens === "number" && actualTokens > 0) {
    return typeof maxTokens === "number"
      ? { actualTokens, maxTokens }
      : { actualTokens };
  }

  // If we have max but not actual, estimate actual as max + 1
  if (typeof maxTokens === "number" && maxTokens > 0) {
    return {
      actualTokens: maxTokens + 1,
      maxTokens,
    };
  }

  return undefined;
}
