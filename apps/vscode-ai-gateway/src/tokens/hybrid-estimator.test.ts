import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "vscode";
import { HybridTokenEstimator, type ModelInfo } from "./hybrid-estimator";

// Mock vscode module
const vscodeHoisted = vi.hoisted(() => {
  const LanguageModelChatMessageRole = {
    User: 1,
    Assistant: 2,
  };

  class LanguageModelTextPart {
    constructor(public value: string) {}
  }

  return {
    LanguageModelChatMessageRole,
    LanguageModelTextPart,
  };
});

vi.mock("vscode", () => vscodeHoisted);

// Mock tiktoken
const tiktokenHoisted = vi.hoisted(() => {
  const mockEncode = vi.fn(
    (
      text: string,
      _allowedSpecial?: string[] | "all",
      _disallowedSpecial?: string[] | "all",
    ) => Array.from({ length: text.length }),
  );
  const mockEncoding = { encode: mockEncode };
  const mockGetEncoding = vi.fn(() => mockEncoding);

  return {
    mockEncode,
    mockEncoding,
    mockGetEncoding,
  };
});

vi.mock("js-tiktoken", () => ({
  getEncoding: tiktokenHoisted.mockGetEncoding,
}));

describe("HybridTokenEstimator", () => {
  let estimator: HybridTokenEstimator;
  let mockContext: ExtensionContext;
  let mockGlobalState: Map<string, unknown>;

  const testModel: ModelInfo = {
    family: "claude",
    maxInputTokens: 100000,
  };

  beforeEach(() => {
    mockGlobalState = new Map();
    mockContext = {
      globalState: {
        get: vi.fn((key: string) => mockGlobalState.get(key)),
        update: vi.fn((key: string, value: unknown) => {
          mockGlobalState.set(key, value);
          return Promise.resolve();
        }),
      },
    } as unknown as ExtensionContext;

    estimator = new HybridTokenEstimator(mockContext);
  });

  describe("estimate", () => {
    it("returns tiktoken estimate for uncalibrated model", () => {
      const result = estimator.estimate("hello world", testModel);

      expect(result.source).toBe("tiktoken");
      expect(result.confidence).toBe("low");
      expect(result.tokens).toBeGreaterThan(0);
    });

    it("returns calibrated estimate after calibration", () => {
      // First estimate to create sequence
      estimator.estimate("hello world", testModel);

      // Calibrate with actual tokens
      estimator.calibrate(testModel, 15);

      // Next estimate should be calibrated
      const result = estimator.estimate("hello world", testModel);

      expect(result.source).toBe("calibrated");
    });

    it("tracks calls in sequence", () => {
      estimator.estimate("hello", testModel);
      estimator.estimate("world", testModel);

      const sequence = estimator.getCurrentSequence();
      expect(sequence?.calls).toHaveLength(2);
    });

    it("applies correction factor to estimate", () => {
      // Pre-seed calibration with correction factor
      const persistedState = [
        {
          modelFamily: "claude",
          correctionFactor: 1.5,
          sampleCount: 5,
          lastCalibrated: Date.now(),
          drift: 0.05,
        },
      ];
      mockGlobalState.set("tokenEstimator.calibrations", persistedState);

      const calibratedEstimator = new HybridTokenEstimator(mockContext);
      const result = calibratedEstimator.estimate("hello", testModel);

      // With correction factor 1.5, tokens should be multiplied
      // "hello" = 5 chars = 5 tokens (mock), * 1.5 = 7.5 -> 8
      expect(result.tokens).toBe(8);
    });
  });

  describe("calibrate", () => {
    it("calibrates from sequence total", () => {
      // Build up a sequence
      estimator.estimate("hello", testModel);
      estimator.estimate("world", testModel);

      const sequence = estimator.getCurrentSequence();
      const estimatedTotal = sequence?.totalEstimate ?? 0;

      // Calibrate with actual tokens
      estimator.calibrate(testModel, estimatedTotal * 1.1);

      // Check calibration was applied
      const state = estimator.getCalibrationState("claude");
      expect(state?.sampleCount).toBe(1);
      expect(state?.correctionFactor).toBeGreaterThan(1);
    });

    it("warns when no sequence exists", () => {
      // No estimate calls, so no sequence
      estimator.calibrate(testModel, 100);

      // Should not create calibration
      expect(estimator.getCalibrationState("claude")).toBeUndefined();
    });
  });

  describe("getEffectiveLimit", () => {
    it("returns 75% for low confidence", () => {
      const result = estimator.getEffectiveLimit(testModel);

      expect(result.confidence).toBe("low");
      expect(result.limit).toBe(75000); // 75% of 100000
    });

    it("returns 85% for medium confidence", () => {
      // Build up medium confidence (4+ samples)
      for (let i = 0; i < 4; i++) {
        estimator.estimate("test", testModel);
        estimator.calibrate(testModel, 5);
      }

      const result = estimator.getEffectiveLimit(testModel);

      expect(result.confidence).toBe("medium");
      expect(result.limit).toBe(85000); // 85% of 100000
    });

    it("returns 95% for high confidence", () => {
      // Build up high confidence (11+ samples, low drift)
      for (let i = 0; i < 11; i++) {
        estimator.estimate("test", testModel);
        // Calibrate with close to estimated (low drift)
        const sequence = estimator.getCurrentSequence();
        estimator.calibrate(testModel, sequence?.totalEstimate ?? 4);
      }

      const result = estimator.getEffectiveLimit(testModel);

      expect(result.confidence).toBe("high");
      expect(result.limit).toBe(95000); // 95% of 100000
    });
  });

  describe("margins", () => {
    it("returns 15% margin for low confidence", () => {
      const result = estimator.estimate("hello", testModel);
      expect(result.margin).toBe(0.15);
    });

    it("returns 10% margin for medium confidence", () => {
      // Build up medium confidence
      for (let i = 0; i < 4; i++) {
        estimator.estimate("test", testModel);
        estimator.calibrate(testModel, 5);
      }

      const result = estimator.estimate("hello", testModel);
      expect(result.margin).toBe(0.1);
    });

    it("returns 5% margin for high confidence", () => {
      // Build up high confidence
      for (let i = 0; i < 11; i++) {
        estimator.estimate("test", testModel);
        const sequence = estimator.getCurrentSequence();
        estimator.calibrate(testModel, sequence?.totalEstimate ?? 4);
      }

      const result = estimator.estimate("hello", testModel);
      expect(result.margin).toBe(0.05);
    });
  });

  describe("reset", () => {
    it("clears sequence and calibrations", () => {
      estimator.estimate("hello", testModel);
      estimator.calibrate(testModel, 10);

      estimator.reset();

      expect(estimator.getCurrentSequence()).toBeNull();
      expect(estimator.getAllCalibrationStates()).toHaveLength(0);
    });
  });
});
