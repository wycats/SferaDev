/**
 * Hybrid Token Estimator (RFC 029)
 *
 * Main facade that integrates CallSequenceTracker and CalibrationManager
 * to provide accurate, confidence-aware token estimates.
 *
 * This replaces the reactive token counting approach with proactive estimation
 * that learns from API responses and tracks call sequences.
 */

import type * as vscode from "vscode";
import { logger } from "../logger";
import { TokenCache } from "./cache";
import {
  CalibrationManager,
  type CalibrationState,
} from "./calibration-manager";
import { TokenCounter } from "./counter";
import {
  CallSequenceTracker,
  type CallSequence,
  type TokenEstimate,
  type TokenEstimateSource,
} from "./sequence-tracker";

/**
 * Model information needed for estimation.
 * Matches the shape of vscode.LanguageModelChatInformation.
 */
export interface ModelInfo {
  family: string;
  maxInputTokens: number;
}

/**
 * Effective token limit with confidence metadata.
 */
export interface EffectiveLimit {
  /** Adjusted limit based on confidence */
  limit: number;
  /** Confidence level */
  confidence: "high" | "medium" | "low";
}

/**
 * Hybrid Token Estimator - main entry point for token estimation.
 *
 * Provides:
 * - Cached API actuals (ground truth)
 * - Calibrated tiktoken estimates (learned correction factors)
 * - Call sequence tracking (per-turn totals)
 * - Confidence-aware margins
 */
export class HybridTokenEstimator {
  private sequenceTracker: CallSequenceTracker;
  private calibrationManager: CalibrationManager;
  private tokenCounter: TokenCounter;
  private tokenCache: TokenCache;

  constructor(context: vscode.ExtensionContext) {
    this.sequenceTracker = new CallSequenceTracker();
    this.calibrationManager = new CalibrationManager(context);
    this.tokenCounter = new TokenCounter();
    this.tokenCache = new TokenCache();
  }

  /**
   * Estimate tokens for content with confidence.
   * Called by provideTokenCount.
   *
   * Returns RAW calibrated estimate - Copilot applies its own margins.
   * We apply margins only for internal validation (pre-flight checks).
   */
  estimate(
    content: string | vscode.LanguageModelChatMessage,
    model: ModelInfo,
  ): TokenEstimate {
    // Try cached API actual first (ground truth)
    if (typeof content !== "string") {
      const cached = this.tokenCache.getCached(content, model.family);
      if (cached !== undefined) {
        const estimate: TokenEstimate = {
          tokens: cached,
          confidence: "high",
          source: "api-actual",
          margin: 0.02,
        };
        this.sequenceTracker.onCall(estimate);
        return estimate;
      }
    }

    // Use tiktoken with calibration
    const rawEstimate =
      typeof content === "string"
        ? this.tokenCounter.estimateTextTokens(content, model.family)
        : this.tokenCounter.estimateMessageTokens(content, model.family);

    const calibration = this.calibrationManager.getCalibration(model.family);
    const calibratedTokens = Math.ceil(
      rawEstimate * (calibration?.correctionFactor ?? 1.0),
    );

    const confidence = this.calibrationManager.getConfidence(model.family);
    const margin = this.getMarginForConfidence(confidence);
    const source: TokenEstimateSource = calibration ? "calibrated" : "tiktoken";

    const estimate: TokenEstimate = {
      tokens: calibratedTokens,
      confidence,
      source,
      margin,
    };

    this.sequenceTracker.onCall(estimate);

    logger.trace(
      `Estimate: ${calibratedTokens.toString()} tokens (${source}, ${confidence} confidence, ` +
        `${(margin * 100).toFixed(0)}% margin)`,
    );

    return estimate;
  }

  /**
   * Calibrate from API response.
   * Called after successful chat response with usage data.
   *
   * @param model - Model information
   * @param actualInputTokens - Actual input tokens from API response
   */
  calibrate(model: ModelInfo, actualInputTokens: number): void {
    const sequence = this.sequenceTracker.getCurrentSequence();
    if (!sequence || sequence.totalEstimate === 0) {
      logger.warn("Cannot calibrate: no current sequence");
      return;
    }

    logger.debug(
      `Calibrating ${model.family}: estimated=${sequence.totalEstimate.toString()}, ` +
        `actual=${actualInputTokens.toString()}, ` +
        `ratio=${(actualInputTokens / sequence.totalEstimate).toFixed(3)}`,
    );

    this.calibrationManager.calibrate(
      model.family,
      sequence.totalEstimate,
      actualInputTokens,
    );
  }

  /**
   * Get effective token limit based on confidence.
   *
   * Returns a reduced limit to account for estimation uncertainty:
   * - High confidence: 95% of limit
   * - Medium confidence: 85% of limit
   * - Low confidence: 75% of limit
   */
  getEffectiveLimit(model: ModelInfo): EffectiveLimit {
    const confidence = this.calibrationManager.getConfidence(model.family);
    const multipliers = {
      high: 0.95, // Use 95% of limit
      medium: 0.85, // Use 85% of limit
      low: 0.75, // Use 75% of limit (conservative)
    };

    return {
      limit: Math.floor(model.maxInputTokens * multipliers[confidence]),
      confidence,
    };
  }

  /**
   * Get calibration state for debugging/status bar.
   */
  getCalibrationState(modelFamily: string): CalibrationState | undefined {
    return this.calibrationManager.getCalibration(modelFamily);
  }

  /**
   * Get all calibration states for debugging.
   */
  getAllCalibrationStates(): CalibrationState[] {
    return this.calibrationManager.getAllCalibrations();
  }

  /**
   * Get current sequence for error detection.
   */
  getCurrentSequence(): CallSequence | null {
    return this.sequenceTracker.getCurrentSequence();
  }

  /**
   * Cache actual token count from API response.
   * Used to build ground truth for future estimates.
   */
  cacheActual(
    message: vscode.LanguageModelChatMessage,
    modelFamily: string,
    actualTokens: number,
  ): void {
    this.tokenCache.cacheActual(message, modelFamily, actualTokens);
  }

  /**
   * Get the underlying token counter (for tool schema counting).
   */
  getTokenCounter(): TokenCounter {
    return this.tokenCounter;
  }

  /**
   * Reset for testing.
   */
  reset(): void {
    this.sequenceTracker.reset();
    this.calibrationManager.resetAll();
  }

  private getMarginForConfidence(confidence: "high" | "medium" | "low"): number {
    switch (confidence) {
      case "high":
        return 0.05; // 5% margin
      case "medium":
        return 0.1; // 10% margin
      case "low":
        return 0.15; // 15% margin
    }
  }
}
