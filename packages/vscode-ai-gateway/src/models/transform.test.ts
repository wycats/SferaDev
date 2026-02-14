import { describe, expect, it } from "vitest";
import {
  transformRawModelsToChatInfo,
  type TransformOptions,
} from "./transform";
import type { Model } from "./types";
import { encodeVsCodeModelId } from "./vscode-model-id";

/** Helper to create a minimal Model for testing. */
function makeModel(
  overrides: Omit<Partial<Model>, "type"> & {
    id: string;
    type?: string | undefined;
  },
): Model {
  const base: Model = {
    id: overrides.id,
    object: "model",
    created: 1700000000,
    owned_by: "test",
    name: overrides.id,
    description: "",
    context_window: 128_000,
    max_tokens: 16_384,
    type: "chat",
    tags: [],
    pricing: { input: "0", output: "0" },
  };
  const { type: typeOverride, ...rest } = overrides;
  const result = { ...base, ...rest };
  // Handle type separately to support explicit undefined (omit the property)
  if (typeOverride === undefined && "type" in overrides) {
    delete (result as Record<string, unknown>)["type"];
  } else if (typeOverride !== undefined) {
    result.type = typeOverride;
  }
  return result;
}

const MODELS: Model[] = [
  makeModel({ id: "openai/gpt-4o" }),
  makeModel({ id: "anthropic/claude-sonnet-4-20250514" }),
  makeModel({ id: "google/gemini-2.0-flash" }),
];

// Helper type to access undocumented VS Code picker fields
type ModelWithPickerFields = ReturnType<
  typeof transformRawModelsToChatInfo
>[0] & {
  isDefault?: boolean;
  isDefaultForLocation?: boolean[];
  isUserSelectable?: boolean;
  capabilities: {
    imageInput: boolean;
    toolCalling: boolean;
    reasoning: boolean;
    webSearch: boolean;
  };
};

describe("transformRawModelsToChatInfo", () => {
  describe("default model selection", () => {
    it("defaults to the first model when no options are provided", () => {
      const result = transformRawModelsToChatInfo(
        MODELS,
      ) as ModelWithPickerFields[];

      expect(result[0]!.isDefault).toBe(true);
      expect(result[0]!.isDefaultForLocation).toBeDefined();
      expect(result[1]!.isDefault).toBeUndefined();
      expect(result[2]!.isDefault).toBeUndefined();
    });

    it("defaults to the first model when options are empty", () => {
      const result = transformRawModelsToChatInfo(
        MODELS,
        {},
      ) as ModelWithPickerFields[];

      expect(result[0]!.isDefault).toBe(true);
      expect(result[1]!.isDefault).toBeUndefined();
    });

    it("defaults to the first model when defaultModelId is not found", () => {
      const options: TransformOptions = {
        defaultModelId: "nonexistent/model",
      };
      const result = transformRawModelsToChatInfo(
        MODELS,
        options,
      ) as ModelWithPickerFields[];

      expect(result[0]!.isDefault).toBe(true);
      expect(result[1]!.isDefault).toBeUndefined();
      expect(result[2]!.isDefault).toBeUndefined();
    });

    it("selects the configured default model", () => {
      const options: TransformOptions = {
        defaultModelId: "anthropic/claude-sonnet-4-20250514",
      };
      const result = transformRawModelsToChatInfo(
        MODELS,
        options,
      ) as ModelWithPickerFields[];

      expect(result[0]!.isDefault).toBeUndefined();
      expect(result[1]!.isDefault).toBe(true);
      expect(result[1]!.isDefaultForLocation).toBeDefined();
      expect(result[1]!.isDefaultForLocation!.length).toBe(32);
      expect(result[1]!.isDefaultForLocation!.every(Boolean)).toBe(true);
      expect(result[2]!.isDefault).toBeUndefined();
    });

    it("selects the last model as default", () => {
      const options: TransformOptions = {
        defaultModelId: "google/gemini-2.0-flash",
      };
      const result = transformRawModelsToChatInfo(
        MODELS,
        options,
      ) as ModelWithPickerFields[];

      expect(result[0]!.isDefault).toBeUndefined();
      expect(result[1]!.isDefault).toBeUndefined();
      expect(result[2]!.isDefault).toBe(true);
    });
  });

  describe("userSelectable", () => {
    it("makes all models user-selectable by default (backward compat)", () => {
      const result = transformRawModelsToChatInfo(
        MODELS,
      ) as ModelWithPickerFields[];

      for (const model of result) {
        expect(model.isUserSelectable).toBe(true);
      }
    });

    it("makes all models user-selectable when userSelectable is true", () => {
      const options: TransformOptions = { userSelectable: true };
      const result = transformRawModelsToChatInfo(
        MODELS,
        options,
      ) as ModelWithPickerFields[];

      for (const model of result) {
        expect(model.isUserSelectable).toBe(true);
      }
    });

    it("only makes the default model selectable when userSelectable is false", () => {
      const options: TransformOptions = { userSelectable: false };
      const result = transformRawModelsToChatInfo(
        MODELS,
        options,
      ) as ModelWithPickerFields[];

      // First model is default (no defaultModelId set)
      expect(result[0]!.isUserSelectable).toBe(true);
      expect(result[1]!.isUserSelectable).toBe(false);
      expect(result[2]!.isUserSelectable).toBe(false);
    });

    it("makes the configured default selectable when userSelectable is false", () => {
      const options: TransformOptions = {
        defaultModelId: "anthropic/claude-sonnet-4-20250514",
        userSelectable: false,
      };
      const result = transformRawModelsToChatInfo(
        MODELS,
        options,
      ) as ModelWithPickerFields[];

      expect(result[0]!.isUserSelectable).toBe(false);
      expect(result[1]!.isUserSelectable).toBe(true); // the configured default
      expect(result[2]!.isUserSelectable).toBe(false);
    });
  });

  describe("model encoding", () => {
    it("encodes model IDs for VS Code", () => {
      const result = transformRawModelsToChatInfo(MODELS);

      expect(result[0]!.id).toBe(encodeVsCodeModelId("openai/gpt-4o"));
      expect(result[1]!.id).toBe(
        encodeVsCodeModelId("anthropic/claude-sonnet-4-20250514"),
      );
    });
  });

  describe("model filtering", () => {
    it("filters out non-chat models", () => {
      const models: Model[] = [
        makeModel({ id: "chat-model", type: "chat" }),
        makeModel({ id: "embedding-model", type: "embedding" }),
        makeModel({ id: "language-model", type: "language" }),
        makeModel({ id: "no-type-model", type: undefined }),
      ];
      const result = transformRawModelsToChatInfo(models);

      const ids = result.map((m) => m.id);
      expect(ids).toContain(encodeVsCodeModelId("chat-model"));
      expect(ids).toContain(encodeVsCodeModelId("language-model"));
      expect(ids).toContain(encodeVsCodeModelId("no-type-model"));
      expect(ids).not.toContain(encodeVsCodeModelId("embedding-model"));
    });
  });

  describe("capabilities", () => {
    it("detects image input from tags", () => {
      const models: Model[] = [
        makeModel({ id: "vision-model", tags: ["vision", "chat"] }),
        makeModel({ id: "text-model", tags: ["chat"] }),
      ];
      const result = transformRawModelsToChatInfo(models);

      expect(result[0]!.capabilities.imageInput).toBe(true);
      expect(result[1]!.capabilities.imageInput).toBe(false);
    });

    it("detects reasoning from tags", () => {
      const models: Model[] = [
        makeModel({ id: "reasoning-model", tags: ["reasoning"] }),
        makeModel({ id: "o1-model", tags: ["o1"] }),
        makeModel({ id: "plain-model", tags: [] }),
      ];
      const result = transformRawModelsToChatInfo(
        models,
      ) as ModelWithPickerFields[];

      expect(result[0]!.capabilities.reasoning).toBe(true);
      expect(result[1]!.capabilities.reasoning).toBe(true);
      expect(result[2]!.capabilities.reasoning).toBe(false);
    });

    it("always advertises tool calling", () => {
      const result = transformRawModelsToChatInfo(MODELS);

      for (const model of result) {
        expect(model.capabilities.toolCalling).toBe(true);
      }
    });
  });

  describe("token limits", () => {
    it("caps tokens at conservative maximums", () => {
      const models: Model[] = [
        makeModel({
          id: "huge-model",
          context_window: 1_000_000,
          max_tokens: 100_000,
        }),
      ];
      const result = transformRawModelsToChatInfo(models);

      expect(result[0]!.maxInputTokens).toBe(128_000);
      expect(result[0]!.maxOutputTokens).toBe(16_384);
    });

    it("preserves smaller token limits", () => {
      const models: Model[] = [
        makeModel({
          id: "small-model",
          context_window: 4_096,
          max_tokens: 2_048,
        }),
      ];
      const result = transformRawModelsToChatInfo(models);

      expect(result[0]!.maxInputTokens).toBe(4_096);
      expect(result[0]!.maxOutputTokens).toBe(2_048);
    });
  });

  describe("empty input", () => {
    it("returns empty array for empty input", () => {
      const result = transformRawModelsToChatInfo([]);
      expect(result).toEqual([]);
    });
  });
});
