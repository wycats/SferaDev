import type { LanguageModelChatInformation } from "vscode";
import {
  CONSERVATIVE_MAX_INPUT_TOKENS,
  CONSERVATIVE_MAX_OUTPUT_TOKENS,
} from "../constants";
import { parseModelIdentity } from "./identity";
import type { Model } from "./types";
import { encodeVsCodeModelId } from "./vscode-model-id";

type VSCodeChatModelInfo = LanguageModelChatInformation & {
  // These fields are relied upon by VS Code's picker logic, but aren't currently
  // represented in the public d.ts surface.
  isUserSelectable?: boolean;
  isDefault?: boolean;
  isDefaultForLocation?: boolean[];
};

export interface TransformOptions {
  /**
   * The raw model ID (before encoding) to mark as default.
   * Falls back to the first model if unset or not found.
   */
  defaultModelId?: string | undefined;
  /**
   * When true, all models are user-selectable in the picker.
   * When false (default), only the default model is user-selectable.
   */
  userSelectable?: boolean | undefined;
}

export function transformRawModelsToChatInfo(
  data: Model[],
  options?: TransformOptions,
): LanguageModelChatInformation[] {
  const imageInputTags = new Set([
    "vision",
    "image",
    "image-input",
    "file-input",
    "multimodal",
  ]);
  const reasoningTags = new Set([
    "reasoning",
    "o1",
    "o3",
    "extended-thinking",
    "extended_thinking",
  ]);
  const webSearchTags = new Set([
    "web-search",
    "web_search",
    "search",
    "grounding",
  ]);

  const filteredModels = data.filter(
    (model) =>
      model.type === "chat" ||
      model.type === "language" ||
      model.type === undefined,
  );

  // VS Code's internal chat UI indexes into `isDefaultForLocation[this.location]`.
  // We don't know the exact enum range across VS Code versions, so use a generous
  // length to ensure at least one model is treated as default for any location.
  const DEFAULT_LOCATION_ARRAY_LEN = 32;

  const defaultModelId = options?.defaultModelId ?? "";
  const userSelectable = options?.userSelectable ?? true;

  // Determine which model index should be the default:
  // 1. If defaultModelId is set and found, use that model
  // 2. Otherwise fall back to the first model (index 0)
  const defaultIndex = defaultModelId
    ? filteredModels.findIndex((m) => m.id === defaultModelId)
    : -1;

  const models: VSCodeChatModelInfo[] = filteredModels.map((model, index) => {
    const rawId = model.id;
    const identity = parseModelIdentity(rawId);
    const tags = (model.tags ?? []).map((tag) => tag.toLowerCase());
    const hasImageInput = tags.some((tag) => imageInputTags.has(tag));
    // Intentionally conservative: always advertise toolCalling, but preserve other caps.
    const hasReasoning = tags.some((tag) => reasoningTags.has(tag));
    const hasWebSearch = tags.some((tag) => webSearchTags.has(tag));

    const maxInputTokens = Math.min(
      model.context_window,
      CONSERVATIVE_MAX_INPUT_TOKENS,
    );
    const maxOutputTokens = Math.min(
      model.max_tokens,
      CONSERVATIVE_MAX_OUTPUT_TOKENS,
    );

    // A model is default if it matches the configured default, or if no
    // configured default was found, the first model wins.
    const isDefault =
      defaultIndex >= 0 ? index === defaultIndex : index === 0;

    return {
      // IMPORTANT: VS Code's internal model picker logic appears to key preferences
      // and persisted selection by identifier strings that assume a single '/'
      // separator between vendor and model id. Our raw ids contain '/', which may
      // confuse internal parsing and also match stale synced picker preferences.
      // Encoding removes '/' and effectively namespaces ids.
      id: encodeVsCodeModelId(rawId),
      name: model.name,
      detail: "Vercel AI Gateway",
      family: identity.family,
      version: identity.version,
      maxInputTokens,
      maxOutputTokens,
      tooltip: model.description || "No description available.",
      // When userSelectable is true, all models appear in the picker.
      // When false, only the default model is selectable (others hidden until
      // the user enables them via VS Code's "Manage Models" UI).
      isUserSelectable: userSelectable || isDefault,
      ...(isDefault
        ? {
            isDefault: true,
            isDefaultForLocation: Array.from(
              { length: DEFAULT_LOCATION_ARRAY_LEN },
              () => true,
            ),
          }
        : null),
      capabilities: {
        imageInput: hasImageInput || false,
        // VS Code Agent mode filters on toolCalling.
        toolCalling: true,
        reasoning: hasReasoning || false,
        webSearch: hasWebSearch || false,
      },
    };
  });

  return models;
}
