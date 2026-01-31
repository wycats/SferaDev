import { beforeEach, describe, expect, it, vi } from "vitest";

// Create hoisted mock functions
const hoisted = vi.hoisted(() => {
  const mockEventEmitterFire = vi.fn();
  const mockEventEmitterDispose = vi.fn();
  const mockEventEmitterEvent = vi.fn();
  const listeners: (() => void)[] = [];

  class MockEventEmitter {
    event = (listener: () => void) => {
      listeners.push(listener);
      mockEventEmitterEvent(listener);
      return { dispose: vi.fn() };
    };
    fire = () => {
      mockEventEmitterFire();
      for (const listener of listeners) {
        listener();
      }
    };
    dispose = mockEventEmitterDispose;
  }

  const mockOutputChannelAppendLine = vi.fn();
  const mockOutputChannelShow = vi.fn();
  const mockOutputChannelDispose = vi.fn();
  const mockCreateOutputChannel = vi.fn(() => ({
    appendLine: mockOutputChannelAppendLine,
    show: mockOutputChannelShow,
    dispose: mockOutputChannelDispose,
  }));
  const mockGetConfiguration = vi.fn();
  const mockOnDidChangeConfiguration = vi.fn(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    (_callback?: unknown) => ({ dispose: vi.fn() }),
  );

  return {
    mockEventEmitterFire,
    mockEventEmitterDispose,
    mockEventEmitterEvent,
    MockEventEmitter,
    mockOutputChannelAppendLine,
    mockOutputChannelShow,
    mockOutputChannelDispose,
    mockCreateOutputChannel,
    mockGetConfiguration,
    mockOnDidChangeConfiguration,
  };
});

// Mock vscode module
vi.mock("vscode", () => ({
  EventEmitter: hoisted.MockEventEmitter,
  window: {
    createOutputChannel: hoisted.mockCreateOutputChannel,
  },
  workspace: {
    getConfiguration: hoisted.mockGetConfiguration,
    onDidChangeConfiguration: hoisted.mockOnDidChangeConfiguration,
  },
}));

// Import after mocking
import {
  _resetOutputChannelForTesting,
  initializeOutputChannel,
  LOG_LEVELS,
  Logger,
} from "./logger";

describe("Logger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the output channel singleton so each test can verify channel creation
    _resetOutputChannelForTesting();
    // Default configuration
    hoisted.mockGetConfiguration.mockReturnValue({
      get: vi.fn((key: string, defaultValue: unknown) => {
        if (key === "logging.level") return "warn";
        if (key === "logging.outputChannel") return true;
        return defaultValue;
      }),
    });
  });

  describe("LOG_LEVELS", () => {
    it("should define correct priority order", () => {
      expect(LOG_LEVELS.off).toBe(0);
      expect(LOG_LEVELS.error).toBe(1);
      expect(LOG_LEVELS.warn).toBe(2);
      expect(LOG_LEVELS.info).toBe(3);
      expect(LOG_LEVELS.debug).toBe(4);
    });

    it("should have higher values for more verbose levels", () => {
      expect(LOG_LEVELS.debug).toBeGreaterThan(LOG_LEVELS.info);
      expect(LOG_LEVELS.info).toBeGreaterThan(LOG_LEVELS.warn);
      expect(LOG_LEVELS.warn).toBeGreaterThan(LOG_LEVELS.error);
      expect(LOG_LEVELS.error).toBeGreaterThan(LOG_LEVELS.off);
    });
  });

  describe("initializeOutputChannel", () => {
    it("should create output channel when called", () => {
      initializeOutputChannel();
      expect(hoisted.mockCreateOutputChannel).toHaveBeenCalledWith(
        "Vercel AI Gateway",
      );
    });

    it("should return a disposable that cleans up the channel", () => {
      const disposable = initializeOutputChannel();
      expect(hoisted.mockCreateOutputChannel).toHaveBeenCalled();

      disposable.dispose();
      expect(hoisted.mockOutputChannelDispose).toHaveBeenCalled();
    });

    it("should only create one channel even if called multiple times", () => {
      initializeOutputChannel();
      initializeOutputChannel();
      expect(hoisted.mockCreateOutputChannel).toHaveBeenCalledTimes(1);
    });
  });

  describe("constructor", () => {
    it("should load configuration on creation", () => {
      new Logger();
      expect(hoisted.mockGetConfiguration).toHaveBeenCalledWith(
        "vercelAiGateway",
      );
    });

    it("should use shared output channel when enabled and initialized", () => {
      hoisted.mockGetConfiguration.mockReturnValue({
        get: vi.fn((key: string) => {
          if (key === "logging.level") return "warn";
          if (key === "logging.outputChannel") return true;
          return undefined;
        }),
      });

      // Initialize the shared channel first (simulates extension activation)
      initializeOutputChannel();
      expect(hoisted.mockCreateOutputChannel).toHaveBeenCalledTimes(1);

      // Creating a logger should NOT create another channel
      new Logger();
      expect(hoisted.mockCreateOutputChannel).toHaveBeenCalledTimes(1);
    });

    it("should not use output channel when disabled", () => {
      hoisted.mockGetConfiguration.mockReturnValue({
        get: vi.fn((key: string) => {
          if (key === "logging.level") return "warn";
          if (key === "logging.outputChannel") return false;
          return undefined;
        }),
      });

      initializeOutputChannel();
      const logger = new Logger();
      logger.info("test");
      // Should not write to output channel when disabled
      expect(hoisted.mockOutputChannelAppendLine).not.toHaveBeenCalled();
    });

    it("should register configuration change listener", () => {
      new Logger();
      expect(hoisted.mockOnDidChangeConfiguration).toHaveBeenCalled();
    });
  });

  describe("level filtering", () => {
    it("should log error when level is error", () => {
      hoisted.mockGetConfiguration.mockReturnValue({
        get: vi.fn((key: string) => {
          if (key === "logging.level") return "error";
          if (key === "logging.outputChannel") return true;
          return undefined;
        }),
      });

      const logger = new Logger();
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      logger.error("test error");
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("should not log warn when level is error", () => {
      hoisted.mockGetConfiguration.mockReturnValue({
        get: vi.fn((key: string) => {
          if (key === "logging.level") return "error";
          if (key === "logging.outputChannel") return false;
          return undefined;
        }),
      });

      const logger = new Logger();
      const consoleSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);

      logger.warn("test warn");
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("should log both error and warn when level is warn", () => {
      hoisted.mockGetConfiguration.mockReturnValue({
        get: vi.fn((key: string) => {
          if (key === "logging.level") return "warn";
          if (key === "logging.outputChannel") return false;
          return undefined;
        }),
      });

      const logger = new Logger();
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);

      logger.error("test error");
      logger.warn("test warn");

      expect(errorSpy).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it("should not log info when level is warn", () => {
      hoisted.mockGetConfiguration.mockReturnValue({
        get: vi.fn((key: string) => {
          if (key === "logging.level") return "warn";
          if (key === "logging.outputChannel") return false;
          return undefined;
        }),
      });

      const logger = new Logger();
      const infoSpy = vi
        .spyOn(console, "info")
        .mockImplementation(() => undefined);

      logger.info("test info");
      expect(infoSpy).not.toHaveBeenCalled();
      infoSpy.mockRestore();
    });

    it("should log all levels when level is debug", () => {
      hoisted.mockGetConfiguration.mockReturnValue({
        get: vi.fn((key: string) => {
          if (key === "logging.level") return "debug";
          if (key === "logging.outputChannel") return false;
          return undefined;
        }),
      });

      const logger = new Logger();
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const infoSpy = vi
        .spyOn(console, "info")
        .mockImplementation(() => undefined);
      const debugSpy = vi
        .spyOn(console, "debug")
        .mockImplementation(() => undefined);

      logger.error("test error");
      logger.warn("test warn");
      logger.info("test info");
      logger.debug("test debug");

      expect(errorSpy).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
      warnSpy.mockRestore();
      infoSpy.mockRestore();
      debugSpy.mockRestore();
    });

    it("should not log anything when level is off", () => {
      hoisted.mockGetConfiguration.mockReturnValue({
        get: vi.fn((key: string) => {
          if (key === "logging.level") return "off";
          if (key === "logging.outputChannel") return false;
          return undefined;
        }),
      });

      const logger = new Logger();
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const infoSpy = vi
        .spyOn(console, "info")
        .mockImplementation(() => undefined);
      const debugSpy = vi
        .spyOn(console, "debug")
        .mockImplementation(() => undefined);

      logger.error("test error");
      logger.warn("test warn");
      logger.info("test info");
      logger.debug("test debug");

      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalled();
      expect(debugSpy).not.toHaveBeenCalled();

      errorSpy.mockRestore();
      warnSpy.mockRestore();
      infoSpy.mockRestore();
      debugSpy.mockRestore();
    });
  });

  describe("output channel", () => {
    it("should write to output channel when enabled", () => {
      hoisted.mockGetConfiguration.mockReturnValue({
        get: vi.fn((key: string) => {
          if (key === "logging.level") return "debug";
          if (key === "logging.outputChannel") return true;
          return undefined;
        }),
      });

      initializeOutputChannel();
      const logger = new Logger();
      vi.spyOn(console, "debug").mockImplementation(() => undefined);

      logger.debug("test message");
      expect(hoisted.mockOutputChannelAppendLine).toHaveBeenCalled();
    });

    it("should include timestamp and level in output", () => {
      hoisted.mockGetConfiguration.mockReturnValue({
        get: vi.fn((key: string) => {
          if (key === "logging.level") return "info";
          if (key === "logging.outputChannel") return true;
          return undefined;
        }),
      });

      initializeOutputChannel();
      const logger = new Logger();
      vi.spyOn(console, "info").mockImplementation(() => undefined);

      logger.info("test message");

      const call = hoisted.mockOutputChannelAppendLine.mock.calls[0]?.[0] as
        | string
        | undefined;
      expect(call).toBeDefined();
      expect(call).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // ISO timestamp
      expect(call).toMatch(/\[INFO\]/);
      expect(call).toContain("test message");
    });

    it("should include additional args in output", () => {
      hoisted.mockGetConfiguration.mockReturnValue({
        get: vi.fn((key: string) => {
          if (key === "logging.level") return "info";
          if (key === "logging.outputChannel") return true;
          return undefined;
        }),
      });

      initializeOutputChannel();
      const logger = new Logger();
      vi.spyOn(console, "info").mockImplementation(() => undefined);

      logger.info("test message", { key: "value" });

      const call = hoisted.mockOutputChannelAppendLine.mock.calls[0]?.[0] as
        | string
        | undefined;
      expect(call).toBeDefined();
      expect(call).toContain("key");
      expect(call).toContain("value");
    });
  });

  describe("show()", () => {
    it("should show output channel when called", () => {
      hoisted.mockGetConfiguration.mockReturnValue({
        get: vi.fn((key: string) => {
          if (key === "logging.level") return "warn";
          if (key === "logging.outputChannel") return true;
          return undefined;
        }),
      });

      // Initialize the shared channel first
      initializeOutputChannel();
      const logger = new Logger();
      logger.show();

      expect(hoisted.mockOutputChannelShow).toHaveBeenCalled();
    });

    it("should not throw when output channel is disabled", () => {
      hoisted.mockGetConfiguration.mockReturnValue({
        get: vi.fn((key: string) => {
          if (key === "logging.level") return "warn";
          if (key === "logging.outputChannel") return false;
          return undefined;
        }),
      });

      const logger = new Logger();
      expect(() => {
        logger.show();
      }).not.toThrow();
    });
  });

  describe("dispose()", () => {
    it("should not dispose shared output channel (managed by extension context)", () => {
      hoisted.mockGetConfiguration.mockReturnValue({
        get: vi.fn((key: string) => {
          if (key === "logging.level") return "warn";
          if (key === "logging.outputChannel") return true;
          return undefined;
        }),
      });

      initializeOutputChannel();
      const logger = new Logger();
      logger.dispose();

      // Logger.dispose() should NOT dispose the shared channel
      // The channel is managed by initializeOutputChannel()'s disposable
      expect(hoisted.mockOutputChannelDispose).not.toHaveBeenCalled();
    });

    it("should not throw when output channel is disabled", () => {
      hoisted.mockGetConfiguration.mockReturnValue({
        get: vi.fn((key: string) => {
          if (key === "logging.level") return "warn";
          if (key === "logging.outputChannel") return false;
          return undefined;
        }),
      });

      const logger = new Logger();
      expect(() => {
        logger.dispose();
      }).not.toThrow();
    });
  });

  describe("configuration change handling", () => {
    it("should update level when configuration changes", () => {
      let configChangeCallback:
        | ((e: { affectsConfiguration: (s: string) => boolean }) => void)
        | undefined;

      (
        hoisted.mockOnDidChangeConfiguration.mockImplementation as (
          fn: unknown,
        ) => void
      )(
        (
          callback: (e: {
            affectsConfiguration: (s: string) => boolean;
          }) => void,
        ) => {
          configChangeCallback = callback;
          return { dispose: vi.fn() };
        },
      );

      // Start with warn level
      hoisted.mockGetConfiguration.mockReturnValue({
        get: vi.fn((key: string) => {
          if (key === "logging.level") return "warn";
          if (key === "logging.outputChannel") return false;
          return undefined;
        }),
      });

      const logger = new Logger();
      const infoSpy = vi
        .spyOn(console, "info")
        .mockImplementation(() => undefined);

      // Info should not log at warn level
      logger.info("test");
      expect(infoSpy).not.toHaveBeenCalled();

      // Change to debug level
      hoisted.mockGetConfiguration.mockReturnValue({
        get: vi.fn((key: string) => {
          if (key === "logging.level") return "debug";
          if (key === "logging.outputChannel") return false;
          return undefined;
        }),
      });

      // Trigger configuration change
      configChangeCallback?.({
        affectsConfiguration: (s: string) => s === "vercelAiGateway",
      });

      // Now info should log
      logger.info("test");
      expect(infoSpy).toHaveBeenCalled();

      infoSpy.mockRestore();
    });
  });
});

// Import extractErrorMessage for testing
import { extractErrorMessage, extractTokenCountFromError } from "./logger";

describe("extractErrorMessage", () => {
  it("should extract message from simple Error object", () => {
    const error = new Error("Something went wrong");
    expect(extractErrorMessage(error)).toBe("Something went wrong");
  });

  it("should return string errors directly", () => {
    expect(extractErrorMessage("Raw error string")).toBe("Raw error string");
  });

  it("should extract message from object with message property", () => {
    const error = { message: "Object error message" };
    expect(extractErrorMessage(error)).toBe("Object error message");
  });

  it("should return fallback for unknown error types", () => {
    expect(extractErrorMessage(null)).toBe("An unexpected error occurred");
    expect(extractErrorMessage(undefined)).toBe("An unexpected error occurred");
    expect(extractErrorMessage(123)).toBe("An unexpected error occurred");
  });

  it("should remove 'undefined: ' prefix from error messages", () => {
    const error = {
      message:
        "undefined: The model returned the following errors: Input is too long",
    };
    expect(extractErrorMessage(error)).toBe(
      "The model returned the following errors: Input is too long",
    );
  });

  it("should remove 'undefined: ' prefix case-insensitively", () => {
    expect(extractErrorMessage("UNDEFINED: Some error")).toBe("Some error");
    expect(extractErrorMessage("Undefined: Another error")).toBe(
      "Another error",
    );
  });

  it("should extract best error from Vercel AI Gateway response body with routing attempts", () => {
    const responseBody = JSON.stringify({
      error: {
        message:
          "undefined: The model returned the following errors: Input is too long for requested model.",
        type: "AI_APICallError",
      },
      providerMetadata: {
        gateway: {
          routing: {
            attempts: [
              {
                provider: "anthropic",
                success: false,
                error: "prompt is too long: 204716 tokens > 200000 maximum",
              },
              {
                provider: "vertexAnthropic",
                success: false,
                error: "Prompt is too long",
              },
              {
                provider: "bedrock",
                success: false,
                error:
                  "undefined: The model returned the following errors: Input is too long for requested model.",
              },
            ],
          },
        },
      },
    });

    const error = { responseBody };
    // Should prefer the Anthropic error because it has more detail (includes token counts)
    expect(extractErrorMessage(error)).toBe(
      "prompt is too long: 204716 tokens > 200000 maximum",
    );
  });

  it("should fall back to first attempt error if no informative error found", () => {
    const responseBody = JSON.stringify({
      error: {
        message: "Generic error",
        type: "AI_APICallError",
      },
      providerMetadata: {
        gateway: {
          routing: {
            attempts: [
              {
                provider: "anthropic",
                success: false,
                error: "First generic error",
              },
              {
                provider: "vertexAnthropic",
                success: false,
                error: "Second generic error",
              },
            ],
          },
        },
      },
    });

    const error = { responseBody };
    expect(extractErrorMessage(error)).toBe("First generic error");
  });

  it("should fall back to top-level error message if no attempts", () => {
    const responseBody = JSON.stringify({
      error: {
        message: "undefined: Top level error",
        type: "AI_APICallError",
      },
    });

    const error = { responseBody };
    expect(extractErrorMessage(error)).toBe("Top level error");
  });

  it("should handle malformed response body gracefully", () => {
    const error = { responseBody: "not valid json", message: "Fallback" };
    expect(extractErrorMessage(error)).toBe("Fallback");
  });
});

describe("extractTokenCountFromError", () => {
  it("should extract token counts from Anthropic-style error", () => {
    const error = {
      message: "prompt is too long: 204716 tokens > 200000 maximum",
    };
    const result = extractTokenCountFromError(error);
    expect(result).toEqual({
      actualTokens: 204716,
      maxTokens: 200000,
    });
  });

  it("should extract token counts from Vercel AI Gateway response body", () => {
    const responseBody = JSON.stringify({
      providerMetadata: {
        gateway: {
          routing: {
            attempts: [
              {
                provider: "anthropic",
                error: "prompt is too long: 150000 tokens > 128000 maximum",
              },
            ],
          },
        },
      },
    });
    const error = { responseBody };
    const result = extractTokenCountFromError(error);
    expect(result).toEqual({
      actualTokens: 150000,
      maxTokens: 128000,
    });
  });

  it("should handle 'exceeds context window' pattern", () => {
    const error = {
      message: "Input exceeds context window of 128000 tokens",
    };
    const result = extractTokenCountFromError(error);
    expect(result).toEqual({
      actualTokens: 128001, // We know it exceeds, so actual is at least max + 1
      maxTokens: 128000,
    });
  });

  it("should return undefined for non-token-related errors", () => {
    const error = new Error("Network connection failed");
    expect(extractTokenCountFromError(error)).toBeUndefined();
  });

  it("should return undefined for generic too long errors without counts", () => {
    const error = {
      message: "Input is too long for requested model.",
    };
    expect(extractTokenCountFromError(error)).toBeUndefined();
  });

  it("should handle token counts with 'token' singular", () => {
    const error = {
      message: "prompt is too long: 1 token > 0 maximum",
    };
    const result = extractTokenCountFromError(error);
    expect(result).toEqual({
      actualTokens: 1,
      maxTokens: 0,
    });
  });

  it("should handle null and undefined", () => {
    expect(extractTokenCountFromError(null)).toBeUndefined();
    expect(extractTokenCountFromError(undefined)).toBeUndefined();
  });
});
