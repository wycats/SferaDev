import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const mockGetConfiguration = vi.fn();
  let configChangeCallback:
    | ((e: { affectsConfiguration: (s: string) => boolean }) => void)
    | undefined;
  const mockOnDidChangeConfiguration = vi.fn(
    (
      callback: (e: { affectsConfiguration: (s: string) => boolean }) => void,
    ) => {
      configChangeCallback = callback;
      return { dispose: vi.fn() };
    },
  );

  const listeners: (() => void)[] = [];
  class MockEventEmitter {
    event = (listener: () => void) => {
      listeners.push(listener);
      return { dispose: vi.fn() };
    };
    fire = () => {
      for (const listener of listeners) {
        listener();
      }
    };
    dispose = vi.fn();
  }

  return {
    mockGetConfiguration,
    mockOnDidChangeConfiguration,
    MockEventEmitter,
    getConfigChangeCallback: () => configChangeCallback,
  };
});

vi.mock("vscode", () => ({
  EventEmitter: hoisted.MockEventEmitter,
  workspace: {
    getConfiguration: hoisted.mockGetConfiguration,
    onDidChangeConfiguration: hoisted.mockOnDidChangeConfiguration,
  },
}));

import { ConfigService, INFERENCE_DEFAULTS } from "./config";

describe("ConfigService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads essential configuration values", () => {
    hoisted.mockGetConfiguration.mockReturnValue({
      get: vi.fn((key: string, defaultValue: unknown) => {
        if (key === "endpoint") return "https://custom.gateway";
        if (key === "models.default") return "anthropic/claude-sonnet-4";
        if (key === "logging.level") return "debug";
        return defaultValue;
      }),
    });

    const config = new ConfigService();

    // User-configurable settings
    expect(config.endpoint).toBe("https://custom.gateway");
    expect(config.modelsDefault).toBe("anthropic/claude-sonnet-4");
    expect(config.logLevel).toBe("debug");
  });

  it("uses hardcoded Copilot defaults for inference settings", () => {
    hoisted.mockGetConfiguration.mockReturnValue({
      get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
    });

    const config = new ConfigService();

    // These are now hardcoded, not configurable
    expect(config.defaultTemperature).toBe(INFERENCE_DEFAULTS.temperature);
    expect(config.defaultTopP).toBe(INFERENCE_DEFAULTS.topP);
    expect(config.defaultMaxOutputTokens).toBe(INFERENCE_DEFAULTS.maxOutputTokens);
    expect(config.timeout).toBe(INFERENCE_DEFAULTS.timeoutMs);
  });

  it("returns sensible defaults for deprecated settings", () => {
    hoisted.mockGetConfiguration.mockReturnValue({
      get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
    });

    const config = new ConfigService();

    // Deprecated settings return fixed values
    expect(config.systemPromptEnabled).toBe(false);
    expect(config.modelsAllowlist).toEqual([]);
    expect(config.modelsDenylist).toEqual([]);
    expect(config.modelsFallbacks).toEqual({});
    expect(config.tokensEstimationMode).toBe("balanced");
    expect(config.tokensCharsPerToken).toBe(4);
    expect(config.modelsEnrichmentEnabled).toBe(true);
    expect(config.statusBarShowOutputTokens).toBe(true);
  });

  it("notifies listeners on configuration changes", () => {
    hoisted.mockGetConfiguration.mockReturnValue({
      get: vi.fn((key: string, defaultValue: unknown) => {
        if (key === "endpoint") return "https://first.gateway";
        return defaultValue;
      }),
    });

    const config = new ConfigService();
    const onChange = vi.fn();
    config.onDidChange(onChange);

    // Update configuration values
    hoisted.mockGetConfiguration.mockReturnValue({
      get: vi.fn((key: string, defaultValue: unknown) => {
        if (key === "endpoint") return "https://second.gateway";
        return defaultValue;
      }),
    });

    hoisted.getConfigChangeCallback()?.({
      affectsConfiguration: (s: string) => s === "vercelAiGateway",
    });

    expect(onChange).toHaveBeenCalled();
    expect(config.endpoint).toBe("https://second.gateway");
  });

  it("disposes resources properly", () => {
    hoisted.mockGetConfiguration.mockReturnValue({
      get: vi.fn(),
    });

    const config = new ConfigService();
    expect(() => { config.dispose(); }).not.toThrow();
  });
});
