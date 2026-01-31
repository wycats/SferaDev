import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const mockGetConfiguration = vi.fn();
  const mockOnDidChangeConfiguration = vi.fn(() => ({ dispose: vi.fn() }));

  class MockEventEmitter {
    private listeners: (() => void)[] = [];
    event = (listener: () => void) => {
      this.listeners.push(listener);
      return { dispose: vi.fn() };
    };
    fire = () => {
      for (const l of this.listeners) l();
    };
    dispose = vi.fn();
  }

  return {
    mockGetConfiguration,
    mockOnDidChangeConfiguration,
    MockEventEmitter,
  };
});

vi.mock("vscode", () => ({
  EventEmitter: hoisted.MockEventEmitter,
  workspace: {
    getConfiguration: hoisted.mockGetConfiguration,
    onDidChangeConfiguration: hoisted.mockOnDidChangeConfiguration,
  },
}));

import {
  ESTIMATION_MODES,
  TokenEstimator,
} from "./estimator";

describe("TokenEstimator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.mockGetConfiguration.mockReturnValue({
      get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
    });
  });

  describe("ESTIMATION_MODES", () => {
    it("should define conservative mode with lowest chars per token", () => {
      expect(ESTIMATION_MODES.conservative).toBe(3);
    });

    it("should define balanced mode with medium chars per token", () => {
      expect(ESTIMATION_MODES.balanced).toBe(4);
    });

    it("should define aggressive mode with highest chars per token", () => {
      expect(ESTIMATION_MODES.aggressive).toBe(5);
    });

    it("should have conservative < balanced < aggressive", () => {
      expect(ESTIMATION_MODES.conservative).toBeLessThan(
        ESTIMATION_MODES.balanced,
      );
      expect(ESTIMATION_MODES.balanced).toBeLessThan(
        ESTIMATION_MODES.aggressive,
      );
    });
  });

  describe("constructor", () => {
    it("should load configuration on creation", () => {
      new TokenEstimator();
      expect(hoisted.mockGetConfiguration).toHaveBeenCalledWith(
        "vercelAiGateway",
      );
    });

    it("should register configuration change listener", () => {
      new TokenEstimator();
      expect(hoisted.mockOnDidChangeConfiguration).toHaveBeenCalled();
    });
  });

  describe("estimateTokens", () => {
    it("should estimate tokens using balanced mode (fixed default)", () => {
      const estimator = new TokenEstimator();
      // "Hello World" = 11 chars, balanced = 4 chars/token -> 2.75 -> ceil = 3
      const result = estimator.estimateTokens("Hello World");
      expect(result).toBe(3);
    });

    // NOTE: Mode configuration tests removed - token estimation now uses fixed balanced mode
    // ConfigService always returns "balanced" and 4 chars/token

    it("should handle empty string", () => {
      const estimator = new TokenEstimator();
      const result = estimator.estimateTokens("");
      expect(result).toBe(0);
    });

    it("should handle very long text", () => {
      const estimator = new TokenEstimator();
      const longText = "a".repeat(10000);
      // 10000 chars, balanced = 4 chars/token -> 2500
      const result = estimator.estimateTokens(longText);
      expect(result).toBe(2500);
    });

    it("should always round up (conservative estimate)", () => {
      const estimator = new TokenEstimator();
      // "Hi" = 2 chars, balanced = 4 chars/token -> 0.5 -> ceil = 1
      const result = estimator.estimateTokens("Hi");
      expect(result).toBe(1);
    });
  });

  describe("getCharsPerToken", () => {
    it("should return balanced mode value (fixed at 4)", () => {
      const estimator = new TokenEstimator();
      expect(estimator.getCharsPerToken()).toBe(4);
    });
  });

  describe("getMode", () => {
    it("should return balanced (fixed default)", () => {
      const estimator = new TokenEstimator();
      expect(estimator.getMode()).toBe("balanced");
    });
  });

  describe("estimateContextUsage", () => {
    it("should calculate percentage of context used", () => {
      const estimator = new TokenEstimator();
      // 1000 tokens used out of 4000 max = 25%
      const result = estimator.estimateContextUsage(1000, 4000);
      expect(result).toBe(25);
    });

    it("should handle zero max tokens", () => {
      const estimator = new TokenEstimator();
      const result = estimator.estimateContextUsage(1000, 0);
      expect(result).toBe(100);
    });

    it("should cap at 100%", () => {
      const estimator = new TokenEstimator();
      const result = estimator.estimateContextUsage(5000, 4000);
      expect(result).toBe(100);
    });

    it("should round to 2 decimal places", () => {
      const estimator = new TokenEstimator();
      // 1000/3000 = 33.333...% -> 33.33%
      const result = estimator.estimateContextUsage(1000, 3000);
      expect(result).toBe(33.33);
    });
  });
});
