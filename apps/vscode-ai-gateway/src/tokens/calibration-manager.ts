/**
 * Calibration Manager for Hybrid Token Estimation (RFC 029)
 *
 * Maintains per-model calibration from API actuals using exponential moving average.
 * Calibration state is persisted to ExtensionContext.globalState for cross-session learning.
 */

import type * as vscode from "vscode";
import { logger } from "../logger";

/**
 * Persisted calibration state for a model family.
 */
export interface CalibrationState {
  /** Model family identifier (e.g., "claude", "gpt-4") */
  modelFamily: string;
  /** EMA of actual/estimated ratios */
  correctionFactor: number;
  /** Number of calibration samples */
  sampleCount: number;
  /** Timestamp of last calibration */
  lastCalibrated: number;
  /** Recent deviation from predictions (0-1) */
  drift: number;
}

/**
 * Storage key for persisted calibration state.
 */
const STORAGE_KEY = "tokenEstimator.calibrations";

/**
 * Manages per-model token calibration using exponential moving average.
 *
 * The correction factor adjusts tiktoken estimates to match actual API token counts.
 * This accounts for differences in tokenization between models.
 */
export class CalibrationManager {
  private calibrations = new Map<string, CalibrationState>();

  /**
   * EMA learning rate (alpha).
   * 0.2 means new observations have 20% weight, history has 80%.
   * This provides smooth adaptation while being responsive to changes.
   */
  private readonly LEARNING_RATE = 0.2;

  constructor(private context: vscode.ExtensionContext) {
    this.loadPersistedState();
  }

  /**
   * Calibrate from an API response.
   *
   * @param modelFamily - The model family (e.g., "claude", "gpt-4")
   * @param estimatedTokens - Our estimate before the API call
   * @param actualTokens - Actual tokens from API response
   */
  calibrate(
    modelFamily: string,
    estimatedTokens: number,
    actualTokens: number,
  ): void {
    if (estimatedTokens <= 0 || actualTokens <= 0) {
      logger.warn(
        `Invalid calibration data: estimated=${estimatedTokens.toString()}, actual=${actualTokens.toString()}`,
      );
      return;
    }

    const state =
      this.calibrations.get(modelFamily) ?? this.defaultState(modelFamily);

    // Calculate observed ratio
    const observedRatio = actualTokens / estimatedTokens;

    // Update correction factor using exponential moving average
    state.correctionFactor =
      this.LEARNING_RATE * observedRatio +
      (1 - this.LEARNING_RATE) * state.correctionFactor;

    // Track drift (how far off we were)
    state.drift = Math.abs(1 - observedRatio);
    state.sampleCount++;
    state.lastCalibrated = Date.now();

    this.calibrations.set(modelFamily, state);
    this.persistState();

    logger.debug(
      `Calibrated ${modelFamily}: factor=${state.correctionFactor.toFixed(3)}, ` +
        `drift=${(state.drift * 100).toFixed(1)}%, samples=${state.sampleCount.toString()}`,
    );
  }

  /**
   * Get calibration state for a model family.
   */
  getCalibration(modelFamily: string): CalibrationState | undefined {
    return this.calibrations.get(modelFamily);
  }

  /**
   * Get confidence level based on calibration quality.
   *
   * - High: Many samples (>10) and low drift (<10%)
   * - Medium: Some samples (>3)
   * - Low: Few or no samples
   */
  getConfidence(modelFamily: string): "high" | "medium" | "low" {
    const state = this.calibrations.get(modelFamily);
    if (!state) return "low";

    // High confidence: many samples, low drift
    if (state.sampleCount > 10 && state.drift < 0.1) return "high";

    // Medium confidence: some samples
    if (state.sampleCount > 3) return "medium";

    return "low";
  }

  /**
   * Get all calibration states (for debugging/status).
   */
  getAllCalibrations(): CalibrationState[] {
    return Array.from(this.calibrations.values());
  }

  /**
   * Reset calibration for a model family (for testing).
   */
  resetCalibration(modelFamily: string): void {
    this.calibrations.delete(modelFamily);
    this.persistState();
  }

  /**
   * Reset all calibrations (for testing).
   */
  resetAll(): void {
    this.calibrations.clear();
    this.persistState();
  }

  private defaultState(modelFamily: string): CalibrationState {
    return {
      modelFamily,
      correctionFactor: 1.0,
      sampleCount: 0,
      lastCalibrated: 0,
      drift: 0,
    };
  }

  private loadPersistedState(): void {
    const persisted =
      this.context.globalState.get<CalibrationState[]>(STORAGE_KEY);
    if (persisted) {
      for (const state of persisted) {
        this.calibrations.set(state.modelFamily, state);
      }
      logger.debug(
        `Loaded ${persisted.length.toString()} calibration states from storage`,
      );
    }
  }

  private persistState(): void {
    const states = Array.from(this.calibrations.values());
    void this.context.globalState.update(STORAGE_KEY, states);
  }
}
