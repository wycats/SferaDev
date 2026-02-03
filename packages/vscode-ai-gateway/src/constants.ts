export const EXTENSION_ID = "vercelAiGateway";
export const VSCODE_EXTENSION_ID = "SferaDev.vscode-extension-vercel-ai";
export const DEFAULT_BASE_URL = "https://ai-gateway.vercel.sh";
export const MODELS_ENDPOINT = "/v1/models";
export const MODELS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const ENRICHMENT_ENDPOINT_PATTERN = "/v1/models";
export const ENRICHMENT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const TOKEN_REFRESH_MARGIN = 15 * 60 * 1000; // 15 minutes
export const LAST_SELECTED_MODEL_KEY = "vercelAiGateway.lastSelectedModel";

/**
 * Conservative token limits to prevent high-context degradation.
 *
 * Research shows that LLM performance degrades significantly as context approaches
 * advertised limits ("context rot"). Models may announce intent to use tools but
 * fail to actually call them, or produce lower-quality outputs.
 *
 * These conservative limits match what VS Code Copilot uses, triggering VS Code's
 * built-in summarization earlier to keep context in the reliable operating range.
 *
 * See: docs/rfcs/stage-0/019-high-context-tool-call-failure.md
 * See: https://research.trychroma.com/context-rot
 */
export const CONSERVATIVE_MAX_INPUT_TOKENS = 128_000;
export const CONSERVATIVE_MAX_OUTPUT_TOKENS = 16_384;

export const ERROR_MESSAGES = {
  AUTH_FAILED:
    "Failed to authenticate with Vercel AI Gateway. Please try again.",
  API_KEY_NOT_FOUND: "Vercel AI Gateway API key not found",
  VERCEL_CLI_NOT_LOGGED_IN:
    "Vercel CLI not logged in. Please run `vercel login` first.",
  MODELS_FETCH_FAILED: "Failed to fetch models from Vercel AI Gateway",
} as const;
