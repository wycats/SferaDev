import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  LanguageModelTextPart: class LanguageModelTextPart {
    constructor(public value: string) {}
  },
  LanguageModelToolCallPart: class LanguageModelToolCallPart {
    constructor(
      public callId: string,
      public name: string,
      public input: unknown,
    ) {}
  },
  LanguageModelThinkingPart: class LanguageModelThinkingPart {
    constructor(public value: string) {}
  },
  LanguageModelDataPart: class LanguageModelDataPart {
    constructor(
      public mimeType: string,
      public data: Uint8Array,
    ) {}
  },
}));

vi.mock("../logger.js", () => ({
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../utils/stateful-marker.js", () => ({
  CustomDataPartMimeTypes: {
    THINKING: "application/vnd.vercel.thinking+json",
    STATEFUL_MARKER: "application/vnd.vercel.stateful-marker+json",
  },
  encodeStatefulMarker: vi.fn(() => new Uint8Array()),
  encodeThinkingData: vi.fn(() => new Uint8Array()),
  STATEFUL_MARKER_MIME: "application/vnd.vercel.stateful-marker+json",
}));

import { ERROR_MESSAGES } from "../constants.js";
import { logger } from "../logger.js";
import { StreamAdapter } from "./stream-adapter";

describe("StreamAdapter error handling", () => {
  let adapter: StreamAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new StreamAdapter("test-conv-id");
  });

  describe("response.failed", () => {
    it("returns friendly RESPONSE_FAILED message to user", () => {
      const result = adapter.adapt({
        type: "response.failed",
        response: {
          id: "resp-1",
          error: {
            message: "Internal processing error: model crashed",
            code: "internal_error",
          },
        },
      } as never);

      expect(result.done).toBe(true);
      expect(result.finishReason).toBe("error");
      // User sees friendly message
      expect(result.parts).toHaveLength(1);
      const textPart = result.parts[0] as { value: string };
      expect(textPart.value).toContain(ERROR_MESSAGES.RESPONSE_FAILED);
      // Raw error preserved in error field for forensics
      expect(result.error).toBe("Internal processing error: model crashed");
    });

    it("logs raw error message for forensics", () => {
      adapter.adapt({
        type: "response.failed",
        response: {
          id: "resp-1",
          error: {
            message: "GPU OOM during inference",
            code: "resource_exhausted",
          },
        },
      } as never);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("GPU OOM during inference"),
      );
    });

    it("handles cancellation errors without friendly message", () => {
      const result = adapter.adapt({
        type: "response.failed",
        response: {
          id: "resp-1",
          error: {
            message: "Request cancelled",
            code: "cancelled",
          },
        },
      } as never);

      expect(result.done).toBe(true);
      expect(result.cancelled).toBe(true);
      expect(result.parts).toHaveLength(0);
    });
  });

  describe("response.incomplete", () => {
    it("emits RESPONSE_TRUNCATED for max_output_tokens", () => {
      const result = adapter.adapt({
        type: "response.incomplete",
        response: {
          id: "resp-1",
          incomplete_details: { reason: "max_output_tokens" },
        },
      } as never);

      expect(result.done).toBe(true);
      expect(result.finishReason).toBe("length");
      expect(result.parts).toHaveLength(1);
      const textPart = result.parts[0] as { value: string };
      expect(textPart.value).toContain(ERROR_MESSAGES.RESPONSE_TRUNCATED);
    });

    it("emits CONTENT_FILTERED for content_filter", () => {
      const result = adapter.adapt({
        type: "response.incomplete",
        response: {
          id: "resp-1",
          incomplete_details: { reason: "content_filter" },
        },
      } as never);

      expect(result.done).toBe(true);
      expect(result.finishReason).toBe("content-filter");
      expect(result.parts).toHaveLength(1);
      const textPart = result.parts[0] as { value: string };
      expect(textPart.value).toContain(ERROR_MESSAGES.CONTENT_FILTERED);
    });

    it("emits generic message for unknown incomplete reason", () => {
      const result = adapter.adapt({
        type: "response.incomplete",
        response: {
          id: "resp-1",
          incomplete_details: { reason: "something_new" },
        },
      } as never);

      expect(result.done).toBe(true);
      expect(result.parts).toHaveLength(1);
      const textPart = result.parts[0] as { value: string };
      expect(textPart.value).toContain("something_new");
    });

    it("does not emit message for cancellation", () => {
      const result = adapter.adapt({
        type: "response.incomplete",
        response: {
          id: "resp-1",
          incomplete_details: { reason: "cancel" },
        },
      } as never);

      expect(result.done).toBe(true);
      expect(result.cancelled).toBe(true);
      expect(result.parts).toHaveLength(0);
    });

    it("logs warning for non-cancellation incomplete", () => {
      adapter.adapt({
        type: "response.incomplete",
        response: {
          id: "resp-1",
          incomplete_details: { reason: "max_output_tokens" },
        },
      } as never);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("response.incomplete"),
      );
    });
  });

  describe("error event", () => {
    it("shows RATE_LIMITED for rate_limit_exceeded code", () => {
      const result = adapter.adapt({
        type: "error",
        error: {
          message: "You have exceeded your rate limit",
          code: "rate_limit_exceeded",
        },
      } as never);

      expect(result.done).toBe(true);
      expect(result.finishReason).toBe("error");
      const textPart = result.parts[0] as { value: string };
      expect(textPart.value).toContain(ERROR_MESSAGES.RATE_LIMITED);
      // Raw error preserved
      expect(result.error).toBe("You have exceeded your rate limit");
    });

    it("shows SERVER_ERROR for server_error code", () => {
      const result = adapter.adapt({
        type: "error",
        error: {
          message: "Internal server error",
          code: "server_error",
        },
      } as never);

      expect(result.done).toBe(true);
      const textPart = result.parts[0] as { value: string };
      expect(textPart.value).toContain(ERROR_MESSAGES.SERVER_ERROR);
    });

    it("shows generic message with code for unknown error codes", () => {
      const result = adapter.adapt({
        type: "error",
        error: {
          message: "Something weird happened",
          code: "weird_error",
        },
      } as never);

      expect(result.done).toBe(true);
      const textPart = result.parts[0] as { value: string };
      expect(textPart.value).toContain("weird_error");
      expect(textPart.value).toContain("Please try again");
    });

    it("handles cancellation errors", () => {
      const result = adapter.adapt({
        type: "error",
        error: {
          message: "Request cancelled",
          code: "cancelled",
        },
      } as never);

      expect(result.done).toBe(true);
      expect(result.cancelled).toBe(true);
      expect(result.parts).toHaveLength(0);
    });

    it("logs raw error for forensics", () => {
      adapter.adapt({
        type: "error",
        error: {
          message: "Detailed internal error info",
          code: "internal_error",
        },
      } as never);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Detailed internal error info"),
      );
    });
  });
});
