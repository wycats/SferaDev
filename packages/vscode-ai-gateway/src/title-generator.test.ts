import { describe, it, expect, vi } from "vitest";

// Mock vscode module before importing TitleGenerator
vi.mock("vscode", () => ({
  lm: {
    selectChatModels: vi.fn().mockResolvedValue([]),
  },
  LanguageModelChatMessage: {
    User: vi.fn((text: string) => ({ role: "user", content: text })),
  },
  CancellationTokenSource: vi.fn(() => ({
    token: { isCancellationRequested: false },
  })),
}));

import { TitleGenerator } from "./title-generator";

describe("TitleGenerator", () => {
  describe("cleanTitle", () => {
    // Create a generator instance to test the private cleanTitle method
    const generator = new TitleGenerator();
    const cleanTitle = (s: string) =>
      (
        generator as unknown as { cleanTitle: (s: string) => string }
      ).cleanTitle.call(generator, s);

    it("removes leading and trailing quotes", () => {
      expect(cleanTitle('"Login Bug Fix"')).toBe("Login Bug Fix");
      expect(cleanTitle("'Login Bug Fix'")).toBe("Login Bug Fix");
    });

    it("removes Title: prefix", () => {
      expect(cleanTitle("Title: Login Bug Fix")).toBe("Login Bug Fix");
      expect(cleanTitle("TITLE: Login Bug Fix")).toBe("Login Bug Fix");
    });

    it("collapses whitespace", () => {
      expect(cleanTitle("Login   Bug   Fix")).toBe("Login Bug Fix");
    });

    it("truncates long titles", () => {
      const longTitle = "A".repeat(100);
      expect(cleanTitle(longTitle).length).toBe(50);
    });

    it("handles combined cleanup", () => {
      expect(cleanTitle('"Title:   Multiple   Spaces"')).toBe(
        "Multiple Spaces",
      );
    });

    it("trims whitespace", () => {
      expect(cleanTitle("  Login Bug Fix  ")).toBe("Login Bug Fix");
    });
  });

  describe("clearCache", () => {
    it("does not throw when called", () => {
      const generator = new TitleGenerator();
      expect(() => { generator.clearCache(); }).not.toThrow();
    });

    it("can be called multiple times", () => {
      const generator = new TitleGenerator();
      generator.clearCache();
      generator.clearCache();
      // No error means success
    });
  });

  // Note: generateTitle tests require VS Code API mocking which is complex.
  // The actual functionality is tested via integration tests.
});
