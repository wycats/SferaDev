import * as vscode from "vscode";
import { DEFAULT_BASE_URL } from "./constants";

export type LogLevel = "off" | "error" | "warn" | "info" | "debug" | "trace";

/**
 * Inference settings based on GCMP (GitHub Copilot) research.
 * These are not configurable - they represent battle-tested defaults.
 *
 * Note: temperature=0 (fully deterministic) was causing tool call issues.
 * GCMP uses temperature=0.1 which is near-deterministic but not fully.
 */
export const INFERENCE_DEFAULTS = {
  /** GCMP uses 0.1 - near-deterministic but allows slight variation */
  temperature: 0.1,
  /** GCMP uses 1 - consider all tokens */
  topP: 1,
  /** Match CONSERVATIVE_MAX_OUTPUT_TOKENS for full output capacity */
  maxOutputTokens: 16_384,
  /** Request timeout */
  timeoutMs: 60_000,
} as const;

export class ConfigService implements vscode.Disposable {
  private config: vscode.WorkspaceConfiguration;
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly disposable: vscode.Disposable;

  constructor() {
    this.config = vscode.workspace.getConfiguration("vercelAiGateway");
    this.disposable = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("vercelAiGateway")) {
        this.config = vscode.workspace.getConfiguration("vercelAiGateway");
        this.emitter.fire();
      }
    });
  }

  get onDidChange(): vscode.Event<void> {
    return this.emitter.event;
  }

  dispose(): void {
    this.disposable.dispose();
    this.emitter.dispose();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Essential settings (user-configurable)
  // ─────────────────────────────────────────────────────────────────────────────

  /** AI Gateway endpoint URL */
  get endpoint(): string {
    return this.config.get("endpoint", DEFAULT_BASE_URL);
  }

  /** OpenResponses API base URL (endpoint + /v1) */
  get openResponsesBaseUrl(): string {
    const trimmed = this.endpoint.replace(/\/+$/, "");
    return `${trimmed}/v1`;
  }

  /** Default model ID (empty = show picker) */
  get modelsDefault(): string {
    return this.config.get("models.default", "");
  }

  /** Logging verbosity */
  get logLevel(): LogLevel {
    return this.config.get("logging.level", "warn");
  }

  /** Enable forensic capture mode */
  get forensicCaptureEnabled(): boolean {
    return this.config.get("debug.forensicCapture", false);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Hardcoded defaults (not user-configurable)
  // Match Copilot's agent mode for reliable tool calling
  // ─────────────────────────────────────────────────────────────────────────────

  get timeout(): number {
    return INFERENCE_DEFAULTS.timeoutMs;
  }

  get defaultTemperature(): number {
    return INFERENCE_DEFAULTS.temperature;
  }

  get defaultTopP(): number {
    return INFERENCE_DEFAULTS.topP;
  }

  get defaultMaxOutputTokens(): number {
    return INFERENCE_DEFAULTS.maxOutputTokens;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Logging infrastructure (always-on, no config needed)
  // ─────────────────────────────────────────────────────────────────────────────

  /** Always show output channel */
  get logOutputChannel(): boolean {
    return true;
  }

  /** No file logging by default */
  get logFileDirectory(): string {
    return "";
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Deprecated/removed settings - kept for compatibility
  // These return sensible defaults; the settings no longer exist
  // ─────────────────────────────────────────────────────────────────────────────

  /** @deprecated Use hardcoded defaults */
  get systemPromptEnabled(): boolean {
    return false;
  }

  /** @deprecated Use hardcoded defaults */
  get systemPromptMessage(): string {
    return "";
  }

  /** @deprecated No longer used */
  get modelsAllowlist(): string[] {
    return [];
  }

  /** @deprecated No longer used */
  get modelsDenylist(): string[] {
    return [];
  }

  /** @deprecated No longer used */
  get modelsFallbacks(): Record<string, string[]> {
    return {};
  }

  /** @deprecated Token estimation now uses balanced mode internally */
  get tokensEstimationMode(): "balanced" {
    return "balanced";
  }

  /** @deprecated Token estimation now uses 4 chars/token internally */
  get tokensCharsPerToken(): number {
    return 4;
  }

  /** @deprecated Enrichment is always enabled */
  get modelsEnrichmentEnabled(): boolean {
    return true;
  }

  /** @deprecated Status bar always shows */
  get statusBarShowOutputTokens(): boolean {
    return true;
  }

  /** @deprecated Tool truncation uses internal defaults */
  get toolTruncationRecentCalls(): number {
    return 6;
  }

  /** @deprecated Tool truncation uses internal defaults */
  get toolTruncationThreshold(): number {
    return 10000;
  }

  /** @deprecated Use hardcoded defaults */
  get debugValidateRequests(): boolean {
    return false;
  }

  /** @deprecated Reasoning effort not configurable */
  get defaultReasoningEffort(): string {
    return "";
  }

  /** @deprecated Old reasoning effort setting */
  get reasoningEffort(): "medium" {
    return "medium";
  }
}
