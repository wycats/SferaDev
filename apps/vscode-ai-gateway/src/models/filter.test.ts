import { beforeEach, describe, expect, it, vi } from "vitest";

// Create hoisted mock functions
const hoisted = vi.hoisted(() => {
  const mockEventEmitterFire = vi.fn();
  const mockEventEmitterDispose = vi.fn();
  const mockEventEmitterEvent = vi.fn();
  const listeners: (() => void)[] = [];

  class MockEventEmitter {
    event = (listener: () => void) => {
      listeners.push(listener);
      mockEventEmitterEvent(listener);
      return { dispose: vi.fn() };
    };
    fire = () => {
      mockEventEmitterFire();
      for (const listener of listeners) {
        listener();
      }
    };
    dispose = mockEventEmitterDispose;
  }

  const mockGetConfiguration = vi.fn();
  const mockOnDidChangeConfiguration = vi.fn(() => ({ dispose: vi.fn() }));

  return {
    mockEventEmitterFire,
    mockEventEmitterDispose,
    mockEventEmitterEvent,
    MockEventEmitter,
    mockGetConfiguration,
    mockOnDidChangeConfiguration,
  };
});

// Mock vscode module
vi.mock("vscode", () => ({
  EventEmitter: hoisted.MockEventEmitter,
  workspace: {
    getConfiguration: hoisted.mockGetConfiguration,
    onDidChangeConfiguration: hoisted.mockOnDidChangeConfiguration,
  },
}));

import { matchesPattern, ModelFilter } from "./filter";

describe("ModelFilter", () => {
  const mockModels = [
    { id: "openai/gpt-4", name: "GPT-4" },
    { id: "openai/gpt-3.5", name: "GPT-3.5" },
    { id: "anthropic/claude-sonnet-4-20250514", name: "Claude 3" },
    { id: "anthropic/claude-2", name: "Claude 2" },
    { id: "google/gemini-pro", name: "Gemini Pro" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.mockGetConfiguration.mockReturnValue({
      get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
    });
  });

  describe("matchesPattern", () => {
    it("should match exact model IDs", () => {
      expect(matchesPattern("openai/gpt-4", "openai/gpt-4")).toBe(true);
      expect(matchesPattern("openai/gpt-4", "openai/gpt-3.5")).toBe(false);
    });

    it("should match wildcard at end", () => {
      expect(matchesPattern("openai/gpt-4", "openai/*")).toBe(true);
      expect(matchesPattern("anthropic/claude", "openai/*")).toBe(false);
    });

    it("should match wildcard at start", () => {
      expect(matchesPattern("openai/gpt-4", "*/gpt-4")).toBe(true);
      expect(matchesPattern("openai/gpt-3.5", "*/gpt-4")).toBe(false);
    });

    it("should match wildcard in middle", () => {
      expect(matchesPattern("openai/gpt-4-turbo", "openai/gpt-*-turbo")).toBe(true);
      expect(matchesPattern("openai/gpt-4", "openai/gpt-*-turbo")).toBe(false);
    });

    it("should match multiple wildcards", () => {
      expect(matchesPattern("openai/gpt-4-turbo", "*/*-turbo")).toBe(true);
      expect(matchesPattern("openai/gpt-4", "*/*-turbo")).toBe(false);
    });

    it("should handle empty pattern", () => {
      expect(matchesPattern("openai/gpt-4", "")).toBe(false);
    });

    it("should handle wildcard-only pattern", () => {
      expect(matchesPattern("openai/gpt-4", "*")).toBe(true);
      expect(matchesPattern("anything", "*")).toBe(true);
    });
  });

  describe("filterModels", () => {
    it("should load configuration on creation", () => {
      new ModelFilter();
      expect(hoisted.mockGetConfiguration).toHaveBeenCalledWith("vercelAiGateway");
    });

    it("should register configuration change listener", () => {
      new ModelFilter();
      expect(hoisted.mockOnDidChangeConfiguration).toHaveBeenCalled();
    });

    it("should return all models when no filters are set", () => {
      const filter = new ModelFilter();
      const result = filter.filterModels(mockModels);
      expect(result).toHaveLength(5);
    });

    // NOTE: Allow/deny list tests removed - these features are now deprecated
    // ConfigService always returns empty arrays for allowlist/denylist
  });

  describe("getFallbacks", () => {
    it("should return empty array when no fallbacks configured", () => {
      const filter = new ModelFilter();
      const result = filter.getFallbacks("openai/gpt-4");
      expect(result).toEqual([]);
    });

    it("should return empty array for model without fallbacks", () => {
      const filter = new ModelFilter();
      const result = filter.getFallbacks("some/other-model");
      expect(result).toEqual([]);
    });
  });

  describe("getDefaultModel", () => {
    it("should return empty string when no default configured", () => {
      const filter = new ModelFilter();
      expect(filter.getDefaultModel()).toBe("");
    });

    it("should return configured default model", () => {
      hoisted.mockGetConfiguration.mockReturnValue({
        get: vi.fn((key: string, defaultValue: unknown) => {
          if (key === "models.default") return "openai/gpt-4";
          return defaultValue;
        }),
      });

      const filter = new ModelFilter();
      expect(filter.getDefaultModel()).toBe("openai/gpt-4");
    });
  });

  // NOTE: Property-based tests for embedding filtering removed
  // The ModelFilter doesn't do type-based filtering - that's done in ModelsClient
  // Since allowlist/denylist are now always empty, filterModels is essentially a pass-through
});
