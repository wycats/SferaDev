import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock vscode module (required by logger)
vi.mock("vscode", () => ({
  window: {
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      dispose: vi.fn(),
    })),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn(),
    })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
  },
}));

import type { ExtensionContext } from "vscode";
import { CalibrationManager } from "./calibration-manager";

describe("CalibrationManager", () => {
  let manager: CalibrationManager;
  let mockContext: ExtensionContext;
  let mockGlobalState: Map<string, unknown>;

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

    manager = new CalibrationManager(mockContext);
  });

  describe("calibrate", () => {
    it("creates new calibration state for unknown model", () => {
      manager.calibrate("claude", 100, 110);

      const state = manager.getCalibration("claude");
      expect(state).toBeDefined();
      expect(state?.modelFamily).toBe("claude");
      expect(state?.sampleCount).toBe(1);
    });

    it("calculates correction factor from ratio", () => {
      // Estimated 100, actual 110 -> ratio 1.1
      manager.calibrate("claude", 100, 110);

      const state = manager.getCalibration("claude");
      // First calibration: EMA = 0.2 * 1.1 + 0.8 * 1.0 = 1.02
      expect(state?.correctionFactor).toBeCloseTo(1.02, 2);
    });

    it("uses EMA for subsequent calibrations", () => {
      // First: estimated 100, actual 110 -> ratio 1.1
      manager.calibrate("claude", 100, 110);
      // Second: estimated 100, actual 120 -> ratio 1.2
      manager.calibrate("claude", 100, 120);

      const state = manager.getCalibration("claude");
      // First: 0.2 * 1.1 + 0.8 * 1.0 = 1.02
      // Second: 0.2 * 1.2 + 0.8 * 1.02 = 1.056
      expect(state?.correctionFactor).toBeCloseTo(1.056, 2);
      expect(state?.sampleCount).toBe(2);
    });

    it("tracks drift as absolute deviation from 1", () => {
      // Ratio 1.1 -> drift 0.1
      manager.calibrate("claude", 100, 110);
      expect(manager.getCalibration("claude")?.drift).toBeCloseTo(0.1, 2);

      // Ratio 0.9 -> drift 0.1
      manager.calibrate("gpt-4", 100, 90);
      expect(manager.getCalibration("gpt-4")?.drift).toBeCloseTo(0.1, 2);
    });

    it("ignores invalid calibration data", () => {
      manager.calibrate("claude", 0, 100);
      manager.calibrate("claude", 100, 0);
      manager.calibrate("claude", -100, 100);

      expect(manager.getCalibration("claude")).toBeUndefined();
    });

    it("persists state after calibration", () => {
      manager.calibrate("claude", 100, 110);

      expect(mockContext.globalState.update).toHaveBeenCalledWith(
        "tokenEstimator.calibrations",
        expect.arrayContaining([
          expect.objectContaining({ modelFamily: "claude" }),
        ]),
      );
    });
  });

  describe("getConfidence", () => {
    it("returns low for unknown model", () => {
      expect(manager.getConfidence("unknown")).toBe("low");
    });

    it("returns low for few samples", () => {
      manager.calibrate("claude", 100, 100);
      manager.calibrate("claude", 100, 100);
      manager.calibrate("claude", 100, 100);

      expect(manager.getConfidence("claude")).toBe("low");
    });

    it("returns medium for 4+ samples", () => {
      for (let i = 0; i < 4; i++) {
        manager.calibrate("claude", 100, 100);
      }

      expect(manager.getConfidence("claude")).toBe("medium");
    });

    it("returns high for 11+ samples with low drift", () => {
      for (let i = 0; i < 11; i++) {
        // Low drift: actual close to estimated
        manager.calibrate("claude", 100, 102);
      }

      expect(manager.getConfidence("claude")).toBe("high");
    });

    it("returns medium for many samples with high drift", () => {
      for (let i = 0; i < 11; i++) {
        // High drift: actual far from estimated
        manager.calibrate("claude", 100, 150);
      }

      // High sample count but drift > 0.1, so medium
      expect(manager.getConfidence("claude")).toBe("medium");
    });
  });

  describe("persistence", () => {
    it("loads persisted state on construction", () => {
      const persistedState = [
        {
          modelFamily: "claude",
          correctionFactor: 1.15,
          sampleCount: 10,
          lastCalibrated: Date.now(),
          drift: 0.05,
        },
      ];
      mockGlobalState.set("tokenEstimator.calibrations", persistedState);

      const newManager = new CalibrationManager(mockContext);
      const state = newManager.getCalibration("claude");

      expect(state?.correctionFactor).toBe(1.15);
      expect(state?.sampleCount).toBe(10);
    });
  });

  describe("reset", () => {
    it("resets single model calibration", () => {
      manager.calibrate("claude", 100, 110);
      manager.calibrate("gpt-4", 100, 120);

      manager.resetCalibration("claude");

      expect(manager.getCalibration("claude")).toBeUndefined();
      expect(manager.getCalibration("gpt-4")).toBeDefined();
    });

    it("resets all calibrations", () => {
      manager.calibrate("claude", 100, 110);
      manager.calibrate("gpt-4", 100, 120);

      manager.resetAll();

      expect(manager.getAllCalibrations()).toHaveLength(0);
    });
  });
});
