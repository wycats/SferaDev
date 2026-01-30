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

  const listeners: Array<() => void> = [];
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

import { ConfigService } from "./config";

describe("ConfigService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads configuration values with defaults", () => {
    hoisted.mockGetConfiguration.mockReturnValue({
      get: vi.fn((key: string, defaultValue: unknown) => {
        if (key === "endpoint") return "https://custom.gateway";
        if (key === "timeout") return 45000;
        if (key === "reasoning.defaultEffort") return "high";
        if (key === "systemPrompt.enabled") return true;
        if (key === "systemPrompt.message") return "Custom system prompt";
        if (key === "logging.level") return "debug";
        if (key === "logging.outputChannel") return false;
        if (key === "models.allowlist") return ["openai/*"];
        if (key === "models.denylist") return ["anthropic/*"];
        if (key === "models.fallbacks")
          return { "openai/gpt-4": ["openai/gpt-3.5"] };
        if (key === "models.default") return "openai/gpt-4";
        if (key === "tokens.estimationMode") return "aggressive";
        if (key === "tokens.charsPerToken") return 3;
        return defaultValue;
      }),
    });

    const config = new ConfigService();

    expect(config.endpoint).toBe("https://custom.gateway");
    expect(config.timeout).toBe(45000);
    expect(config.reasoningEffort).toBe("high");
    expect(config.systemPromptEnabled).toBe(true);
    expect(config.systemPromptMessage).toBe("Custom system prompt");
    expect(config.logLevel).toBe("debug");
    expect(config.logOutputChannel).toBe(false);
    expect(config.modelsAllowlist).toEqual(["openai/*"]);
    expect(config.modelsDenylist).toEqual(["anthropic/*"]);
    expect(config.modelsFallbacks).toEqual({
      "openai/gpt-4": ["openai/gpt-3.5"],
    });
    expect(config.modelsDefault).toBe("openai/gpt-4");
    expect(config.tokensEstimationMode).toBe("aggressive");
    expect(config.tokensCharsPerToken).toBe(3);
  });

  it("notifies listeners and refreshes on configuration changes", () => {
    hoisted.mockGetConfiguration.mockReturnValue({
      get: vi.fn((key: string, defaultValue: unknown) => {
        if (key === "endpoint") return "https://first.gateway";
        if (key === "timeout") return 30000;
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
        if (key === "timeout") return 60000;
        return defaultValue;
      }),
    });

    hoisted.getConfigChangeCallback()?.({
      affectsConfiguration: (s: string) => s === "vercelAiGateway",
    });

    expect(onChange).toHaveBeenCalled();
    expect(config.endpoint).toBe("https://second.gateway");
    expect(config.timeout).toBe(60000);
  });
});
