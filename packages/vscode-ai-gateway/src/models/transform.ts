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

export function transformRawModelsToChatInfo(
  data: Model[],
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

    const isDefault = index === 0;

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
      // Critical for selection persistence.
      isUserSelectable: true,
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
