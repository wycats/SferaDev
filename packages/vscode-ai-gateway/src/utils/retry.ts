/**
 * Retry Utility
 *
 * Provides exponential backoff retry logic for transient failures.
 * Designed for use with the OpenResponses API where network errors
 * and server-side transient failures are common.
 *
 * Retryable conditions:
 * - Network errors (ECONNREFUSED, ENOTFOUND, ETIMEDOUT, fetch failed)
 * - HTTP 429 (rate limit) — respects Retry-After header
 * - HTTP 502, 503 (gateway/service unavailable)
 * - HTTP 500 (internal server error) — retry once only
 *
 * Non-retryable conditions:
 * - HTTP 401, 403 (auth — needs user action)
 * - HTTP 404 (not found — needs user action)
 * - HTTP 400 (bad request — needs code fix)
 * - Cancellation/abort errors
 * - Unknown errors (conservative — don't retry)
 */

import { logger } from "../logger.js";

/** Configuration for retry behavior */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries: number;
  /** Initial delay in milliseconds before first retry (default: 1000) */
  initialDelayMs: number;
  /** Multiplier applied to delay after each retry (default: 2) */
  backoffMultiplier: number;
  /** Maximum delay in milliseconds (default: 16000) */
  maxDelayMs: number;
  /** Jitter factor (0-1) — randomizes delay by ±factor (default: 0.25) */
  jitterFactor: number;
}

/** Default retry configuration */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 16_000,
  jitterFactor: 0.25,
};

/** Result of classifying an error for retry eligibility */
export interface RetryClassification {
  /** Whether the error is retryable */
  retryable: boolean;
  /** Maximum retries for this error type (may be less than config.maxRetries) */
  maxRetries: number;
  /** Suggested delay override in ms (e.g., from Retry-After header) */
  suggestedDelayMs?: number;
  /** Human-readable reason for the classification */
  reason: string;
}

/**
 * Classify an error to determine if it should be retried.
 *
 * @param error - The error to classify
 * @returns Classification with retry eligibility and constraints
 */
export function classifyForRetry(error: unknown): RetryClassification {
  // Check for cancellation/abort — never retry
  if (error instanceof Error) {
    if (
      error.name === "AbortError" ||
      error.message.includes("abort") ||
      error.message.includes("cancel")
    ) {
      return {
        retryable: false,
        maxRetries: 0,
        reason: "Cancellation — not retryable",
      };
    }
  }

  // Check for OpenResponsesError (has .status property)
  if (isHttpError(error)) {
    const status = error.status;

    // Rate limit — retryable with Retry-After respect
    if (status === 429) {
      const retryAfter = extractRetryAfter(error);
      return {
        retryable: true,
        maxRetries: 3,
        ...(retryAfter !== undefined && { suggestedDelayMs: retryAfter }),
        reason: "Rate limited (429)",
      };
    }

    // Gateway errors — retryable
    if (status === 502 || status === 503) {
      return {
        retryable: true,
        maxRetries: 3,
        reason: `Service unavailable (${status})`,
      };
    }

    // Internal server error — retry once only (ambiguous)
    if (status === 500) {
      return {
        retryable: true,
        maxRetries: 1,
        reason: "Internal server error (500) — retry once",
      };
    }

    // Auth errors — not retryable (needs user action)
    if (status === 401 || status === 403) {
      return {
        retryable: false,
        maxRetries: 0,
        reason: `Auth error (${status}) — needs user action`,
      };
    }

    // Not found — not retryable (needs user action)
    if (status === 404) {
      return {
        retryable: false,
        maxRetries: 0,
        reason: "Not found (404) — needs user action",
      };
    }

    // Bad request — not retryable (needs code fix)
    if (status === 400) {
      return {
        retryable: false,
        maxRetries: 0,
        reason: "Bad request (400) — not retryable",
      };
    }

    // Other HTTP errors — not retryable by default
    return {
      retryable: false,
      maxRetries: 0,
      reason: `HTTP ${status} — not retryable`,
    };
  }

  // Network errors — retryable
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes("econnrefused") ||
      msg.includes("enotfound") ||
      msg.includes("etimedout") ||
      msg.includes("econnreset") ||
      msg.includes("fetch failed") ||
      msg.includes("network") ||
      msg.includes("dns")
    ) {
      return {
        retryable: true,
        maxRetries: 3,
        reason: "Network error — retryable",
      };
    }
  }

  // Unknown errors — conservative, don't retry
  return {
    retryable: false,
    maxRetries: 0,
    reason: "Unknown error — not retryable",
  };
}

/**
 * Calculate the delay for a given retry attempt.
 *
 * Uses exponential backoff with jitter:
 *   delay = min(initialDelay * multiplier^attempt, maxDelay) * (1 ± jitter)
 *
 * @param attempt - Zero-based retry attempt number
 * @param config - Retry configuration
 * @param suggestedDelayMs - Optional delay override (e.g., from Retry-After)
 * @returns Delay in milliseconds
 */
export function calculateRetryDelay(
  attempt: number,
  config: RetryConfig,
  suggestedDelayMs?: number,
): number {
  // If a suggested delay is provided (e.g., Retry-After), use it as minimum
  const baseDelay =
    config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt);
  const cappedDelay = Math.min(baseDelay, config.maxDelayMs);

  // Apply jitter: delay * (1 ± jitterFactor)
  const jitter = 1 + (Math.random() * 2 - 1) * config.jitterFactor;
  const jitteredDelay = cappedDelay * jitter;

  // If suggested delay is provided, use the larger of the two
  if (suggestedDelayMs !== undefined) {
    return Math.max(jitteredDelay, suggestedDelayMs);
  }

  return jitteredDelay;
}

/**
 * Execute a function with retry logic.
 *
 * @param fn - The async function to execute
 * @param config - Retry configuration (defaults to DEFAULT_RETRY_CONFIG)
 * @param signal - Optional AbortSignal to cancel retries
 * @returns The result of the function
 * @throws The last error if all retries are exhausted
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  signal?: AbortSignal,
): Promise<T> {
  const fullConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: unknown;

  for (let attempt = 0; attempt <= fullConfig.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if cancelled
      if (signal?.aborted) {
        throw error;
      }

      // Classify the error
      const classification = classifyForRetry(error);

      // Not retryable — throw immediately
      if (!classification.retryable) {
        throw error;
      }

      // Check if we've exceeded the error-specific max retries
      if (attempt >= classification.maxRetries) {
        logger.warn(
          `[Retry] Exhausted ${classification.maxRetries} retries for: ${classification.reason}`,
        );
        throw error;
      }

      // Check if we've exceeded the global max retries
      if (attempt >= fullConfig.maxRetries) {
        logger.warn(
          `[Retry] Exhausted ${fullConfig.maxRetries} global retries`,
        );
        throw error;
      }

      // Calculate delay
      const delay = calculateRetryDelay(
        attempt,
        fullConfig,
        classification.suggestedDelayMs,
      );

      logger.info(
        `[Retry] Attempt ${(attempt + 1).toString()}/${Math.min(classification.maxRetries, fullConfig.maxRetries).toString()} ` +
          `failed (${classification.reason}). Retrying in ${Math.round(delay).toString()}ms...`,
      );

      // Wait before retrying
      await sleep(delay, signal);
    }
  }

  // Should not reach here, but just in case
  throw lastError;
}

// ===== Internal Helpers =====

/** Type guard for errors with an HTTP status code */
interface HttpError {
  status: number;
  headers?: Record<string, string> | Headers;
}

function isHttpError(error: unknown): error is HttpError {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as HttpError).status === "number"
  );
}

/**
 * Extract Retry-After header value in milliseconds.
 * Supports both seconds (integer) and HTTP-date formats.
 */
function extractRetryAfter(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;

  const headers = (error as { headers?: unknown }).headers;
  if (!headers) return undefined;

  let retryAfterValue: string | null = null;

  if (headers instanceof Headers) {
    retryAfterValue = headers.get("retry-after");
  } else if (typeof headers === "object") {
    const headerRecord = headers as Record<string, string>;
    retryAfterValue =
      headerRecord["retry-after"] ?? headerRecord["Retry-After"] ?? null;
  }

  if (!retryAfterValue) return undefined;

  // Try parsing as seconds (integer)
  const seconds = parseInt(retryAfterValue, 10);
  if (!isNaN(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  // Try parsing as HTTP-date
  const date = new Date(retryAfterValue);
  if (!isNaN(date.getTime())) {
    const delayMs = date.getTime() - Date.now();
    return delayMs > 0 ? delayMs : undefined;
  }

  return undefined;
}

/** Sleep for a given duration, respecting an optional abort signal */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }

    const timer = setTimeout(resolve, ms);

    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      },
      { once: true },
    );
  });
}
