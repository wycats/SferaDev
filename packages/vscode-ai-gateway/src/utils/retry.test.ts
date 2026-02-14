import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger.js", () => ({
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  classifyForRetry,
  calculateRetryDelay,
  withRetry,
  DEFAULT_RETRY_CONFIG,
  type RetryConfig,
} from "./retry";

describe("classifyForRetry", () => {
  describe("cancellation errors", () => {
    it("classifies AbortError as non-retryable", () => {
      const error = new Error("abort");
      error.name = "AbortError";
      const result = classifyForRetry(error);
      expect(result.retryable).toBe(false);
      expect(result.reason).toContain("Cancellation");
    });

    it("classifies errors with 'cancel' in message as non-retryable", () => {
      const result = classifyForRetry(new Error("Request cancelled by user"));
      expect(result.retryable).toBe(false);
    });
  });

  describe("HTTP status errors", () => {
    const makeHttpError = (
      status: number,
      headers?: Record<string, string>,
    ) => ({
      status,
      message: `HTTP ${status}`,
      headers,
    });

    it("classifies 429 as retryable with 3 retries", () => {
      const result = classifyForRetry(makeHttpError(429));
      expect(result.retryable).toBe(true);
      expect(result.maxRetries).toBe(3);
      expect(result.reason).toContain("429");
    });

    it("extracts Retry-After header for 429", () => {
      const result = classifyForRetry(
        makeHttpError(429, { "retry-after": "5" }),
      );
      expect(result.retryable).toBe(true);
      expect(result.suggestedDelayMs).toBe(5000);
    });

    it("classifies 502 as retryable", () => {
      const result = classifyForRetry(makeHttpError(502));
      expect(result.retryable).toBe(true);
      expect(result.maxRetries).toBe(3);
    });

    it("classifies 503 as retryable", () => {
      const result = classifyForRetry(makeHttpError(503));
      expect(result.retryable).toBe(true);
      expect(result.maxRetries).toBe(3);
    });

    it("classifies 500 as retryable with 1 retry only", () => {
      const result = classifyForRetry(makeHttpError(500));
      expect(result.retryable).toBe(true);
      expect(result.maxRetries).toBe(1);
    });

    it("classifies 401 as non-retryable", () => {
      const result = classifyForRetry(makeHttpError(401));
      expect(result.retryable).toBe(false);
      expect(result.reason).toContain("Auth");
    });

    it("classifies 403 as non-retryable", () => {
      const result = classifyForRetry(makeHttpError(403));
      expect(result.retryable).toBe(false);
    });

    it("classifies 404 as non-retryable", () => {
      const result = classifyForRetry(makeHttpError(404));
      expect(result.retryable).toBe(false);
      expect(result.reason).toContain("Not found");
    });

    it("classifies 400 as non-retryable", () => {
      const result = classifyForRetry(makeHttpError(400));
      expect(result.retryable).toBe(false);
      expect(result.reason).toContain("Bad request");
    });

    it("classifies unknown HTTP status as non-retryable", () => {
      const result = classifyForRetry(makeHttpError(418));
      expect(result.retryable).toBe(false);
    });
  });

  describe("network errors", () => {
    it("classifies ECONNREFUSED as retryable", () => {
      const result = classifyForRetry(
        new Error("connect ECONNREFUSED 127.0.0.1:443"),
      );
      expect(result.retryable).toBe(true);
      expect(result.maxRetries).toBe(3);
      expect(result.reason).toContain("Network");
    });

    it("classifies ENOTFOUND as retryable", () => {
      const result = classifyForRetry(
        new Error("getaddrinfo ENOTFOUND example.com"),
      );
      expect(result.retryable).toBe(true);
    });

    it("classifies ETIMEDOUT as retryable", () => {
      const result = classifyForRetry(new Error("connect ETIMEDOUT"));
      expect(result.retryable).toBe(true);
    });

    it("classifies ECONNRESET as retryable", () => {
      const result = classifyForRetry(new Error("read ECONNRESET"));
      expect(result.retryable).toBe(true);
    });

    it("classifies 'fetch failed' as retryable", () => {
      const result = classifyForRetry(new TypeError("fetch failed"));
      expect(result.retryable).toBe(true);
    });
  });

  describe("unknown errors", () => {
    it("classifies unknown errors as non-retryable", () => {
      const result = classifyForRetry(new Error("Something unexpected"));
      expect(result.retryable).toBe(false);
    });

    it("classifies non-Error objects as non-retryable", () => {
      const result = classifyForRetry("string error");
      expect(result.retryable).toBe(false);
    });

    it("classifies null as non-retryable", () => {
      const result = classifyForRetry(null);
      expect(result.retryable).toBe(false);
    });
  });
});

describe("calculateRetryDelay", () => {
  const config: RetryConfig = {
    maxRetries: 3,
    initialDelayMs: 1000,
    backoffMultiplier: 2,
    maxDelayMs: 16000,
    jitterFactor: 0, // No jitter for deterministic tests
  };

  it("returns initialDelayMs for first attempt", () => {
    const delay = calculateRetryDelay(0, config);
    expect(delay).toBe(1000);
  });

  it("doubles delay for each attempt", () => {
    expect(calculateRetryDelay(1, config)).toBe(2000);
    expect(calculateRetryDelay(2, config)).toBe(4000);
    expect(calculateRetryDelay(3, config)).toBe(8000);
  });

  it("caps delay at maxDelayMs", () => {
    expect(calculateRetryDelay(10, config)).toBe(16000);
  });

  it("uses suggestedDelayMs when larger than calculated", () => {
    const delay = calculateRetryDelay(0, config, 5000);
    expect(delay).toBe(5000);
  });

  it("uses calculated delay when larger than suggestedDelayMs", () => {
    const delay = calculateRetryDelay(2, config, 1000);
    expect(delay).toBe(4000);
  });

  it("applies jitter within expected range", () => {
    const jitterConfig = { ...config, jitterFactor: 0.25 };
    const delays = Array.from({ length: 100 }, () =>
      calculateRetryDelay(0, jitterConfig),
    );
    // All delays should be within ±25% of 1000ms
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(750);
      expect(d).toBeLessThanOrEqual(1250);
    }
  });
});

describe("withRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("success");
    const result = await withRetry(fn, { maxRetries: 3, jitterFactor: 0 });
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws immediately for non-retryable errors", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 404, message: "Not found" });
    await expect(
      withRetry(fn, { maxRetries: 3, jitterFactor: 0 }),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable errors and succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockResolvedValue("recovered");

    const promise = withRetry(fn, {
      maxRetries: 3,
      initialDelayMs: 100,
      jitterFactor: 0,
    });

    // Advance past the retry delay
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("exhausts retries and throws last error", async () => {
    vi.useRealTimers();
    const networkError = new Error("connect ECONNREFUSED");
    const fn = vi.fn().mockRejectedValue(networkError);

    await expect(
      withRetry(fn, {
        maxRetries: 2,
        initialDelayMs: 1,
        jitterFactor: 0,
      }),
    ).rejects.toThrow("ECONNREFUSED");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("respects error-specific maxRetries (500 = 1 retry)", async () => {
    vi.useRealTimers();
    const serverError = { status: 500, message: "Internal Server Error" };
    const fn = vi.fn().mockRejectedValue(serverError);

    await expect(
      withRetry(fn, {
        maxRetries: 3,
        initialDelayMs: 1,
        jitterFactor: 0,
      }),
    ).rejects.toEqual(expect.objectContaining({ status: 500 }));
    expect(fn).toHaveBeenCalledTimes(2); // initial + 1 retry (500 maxRetries=1)
  });

  it("respects abort signal", async () => {
    vi.useRealTimers();
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));

    // Abort immediately so the retry loop sees it after first failure
    controller.abort();

    await expect(
      withRetry(
        fn,
        { maxRetries: 3, initialDelayMs: 1, jitterFactor: 0 },
        controller.signal,
      ),
    ).rejects.toThrow();
    // Should not retry after abort
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("DEFAULT_RETRY_CONFIG", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_RETRY_CONFIG.maxRetries).toBe(3);
    expect(DEFAULT_RETRY_CONFIG.initialDelayMs).toBe(1000);
    expect(DEFAULT_RETRY_CONFIG.backoffMultiplier).toBe(2);
    expect(DEFAULT_RETRY_CONFIG.maxDelayMs).toBe(16000);
    expect(DEFAULT_RETRY_CONFIG.jitterFactor).toBe(0.25);
  });
});
