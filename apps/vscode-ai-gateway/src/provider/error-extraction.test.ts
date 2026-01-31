/**
 * Tests for error extraction utilities.
 */

import { describe, expect, it, vi } from "vitest";
import { OpenResponsesError } from "openresponses-client";

// Mock the logger
vi.mock("../logger.js", () => ({
  logger: {
    debug: vi.fn(),
  },
  extractTokenCountFromError: vi.fn(),
}));

import { extractTokenInfoFromDetails } from "./error-extraction.js";

// Create a helper to construct OpenResponsesError instances for testing
function createOpenResponsesError(
  message: string,
  status: number,
  details?: unknown,
): OpenResponsesError {
  const error = new OpenResponsesError(message, { status });
  // Manually set details since the constructor doesn't accept it directly
  (error as unknown as { details: unknown }).details = details;
  return error;
}

describe("extractTokenInfoFromDetails", () => {
  describe("non-OpenResponsesError input", () => {
    it("should return undefined for regular Error", () => {
      const error = new Error("something went wrong");
      expect(extractTokenInfoFromDetails(error)).toBeUndefined();
    });

    it("should return undefined for null", () => {
      expect(extractTokenInfoFromDetails(null)).toBeUndefined();
    });

    it("should return undefined for undefined", () => {
      expect(extractTokenInfoFromDetails(undefined)).toBeUndefined();
    });

    it("should return undefined for string error", () => {
      expect(extractTokenInfoFromDetails("error")).toBeUndefined();
    });

    it("should return undefined for number", () => {
      expect(extractTokenInfoFromDetails(500)).toBeUndefined();
    });
  });

  describe("OpenResponsesError without token details", () => {
    it("should return undefined when details is undefined", () => {
      const error = createOpenResponsesError("message", 400);
      expect(extractTokenInfoFromDetails(error)).toBeUndefined();
    });

    it("should return undefined when details.error is missing", () => {
      const error = createOpenResponsesError("message", 400, { foo: "bar" });
      expect(extractTokenInfoFromDetails(error)).toBeUndefined();
    });

    it("should return undefined when details.error.param is missing", () => {
      const error = createOpenResponsesError("message", 400, {
        error: { message: "too long" },
      });
      expect(extractTokenInfoFromDetails(error)).toBeUndefined();
    });

    it("should return undefined when param is empty object", () => {
      const error = createOpenResponsesError("message", 400, {
        error: { param: {} },
      });
      expect(extractTokenInfoFromDetails(error)).toBeUndefined();
    });
  });

  describe("structured token extraction", () => {
    it("should extract actual_tokens and max_tokens", () => {
      const error = createOpenResponsesError("message", 400, {
        error: {
          param: { actual_tokens: 150000, max_tokens: 128000 },
        },
      });
      expect(extractTokenInfoFromDetails(error)).toEqual({
        actualTokens: 150000,
        maxTokens: 128000,
      });
    });

    it("should extract token_count as actualTokens", () => {
      const error = createOpenResponsesError("message", 400, {
        error: {
          param: { token_count: 200000, max_tokens: 128000 },
        },
      });
      expect(extractTokenInfoFromDetails(error)).toEqual({
        actualTokens: 200000,
        maxTokens: 128000,
      });
    });

    it("should extract limit as maxTokens", () => {
      const error = createOpenResponsesError("message", 400, {
        error: {
          param: { actual_tokens: 150000, limit: 100000 },
        },
      });
      expect(extractTokenInfoFromDetails(error)).toEqual({
        actualTokens: 150000,
        maxTokens: 100000,
      });
    });

    it("should prefer actual_tokens over token_count", () => {
      const error = createOpenResponsesError("message", 400, {
        error: {
          param: { actual_tokens: 150000, token_count: 200000, max_tokens: 128000 },
        },
      });
      expect(extractTokenInfoFromDetails(error)).toEqual({
        actualTokens: 150000,
        maxTokens: 128000,
      });
    });

    it("should prefer max_tokens over limit", () => {
      const error = createOpenResponsesError("message", 400, {
        error: {
          param: { actual_tokens: 150000, max_tokens: 128000, limit: 100000 },
        },
      });
      expect(extractTokenInfoFromDetails(error)).toEqual({
        actualTokens: 150000,
        maxTokens: 128000,
      });
    });

    it("should return actualTokens only when max_tokens is missing", () => {
      const error = createOpenResponsesError("message", 400, {
        error: {
          param: { actual_tokens: 150000 },
        },
      });
      expect(extractTokenInfoFromDetails(error)).toEqual({
        actualTokens: 150000,
      });
    });

    it("should estimate actualTokens as max+1 when only max_tokens is present", () => {
      const error = createOpenResponsesError("message", 400, {
        error: {
          param: { max_tokens: 128000 },
        },
      });
      expect(extractTokenInfoFromDetails(error)).toEqual({
        actualTokens: 128001,
        maxTokens: 128000,
      });
    });

    it("should estimate actualTokens as limit+1 when only limit is present", () => {
      const error = createOpenResponsesError("message", 400, {
        error: {
          param: { limit: 100000 },
        },
      });
      expect(extractTokenInfoFromDetails(error)).toEqual({
        actualTokens: 100001,
        maxTokens: 100000,
      });
    });

    it("should fall back to max+1 when actual_tokens is zero", () => {
      const error = createOpenResponsesError("message", 400, {
        error: {
          param: { actual_tokens: 0, max_tokens: 128000 },
        },
      });
      // Zero actual_tokens is treated as invalid, so falls back to max+1
      expect(extractTokenInfoFromDetails(error)).toEqual({
        actualTokens: 128001,
        maxTokens: 128000,
      });
    });

    it("should fall back to max+1 when actual_tokens is negative", () => {
      const error = createOpenResponsesError("message", 400, {
        error: {
          param: { actual_tokens: -100, max_tokens: 128000 },
        },
      });
      // Negative is treated as invalid, falls back to max+1
      expect(extractTokenInfoFromDetails(error)).toEqual({
        actualTokens: 128001,
        maxTokens: 128000,
      });
    });
  });
});
