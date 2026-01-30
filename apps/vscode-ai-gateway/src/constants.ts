export const EXTENSION_ID = "vercelAiGateway";
export const VSCODE_EXTENSION_ID = "SferaDev.vscode-extension-vercel-ai";
export const DEFAULT_BASE_URL = "https://ai-gateway.vercel.sh";
export const MODELS_ENDPOINT = "/v1/models";
export const MODELS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const ENRICHMENT_ENDPOINT_PATTERN = "/v1/models";
export const ENRICHMENT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const TOKEN_REFRESH_MARGIN = 15 * 60 * 1000; // 15 minutes
export const LAST_SELECTED_MODEL_KEY = "vercelAiGateway.lastSelectedModel";
export const DEFAULT_TIMEOUT_MS = 30000;
export const DEFAULT_REASONING_EFFORT = "medium" as const;
export const DEFAULT_SYSTEM_PROMPT_MESSAGE =
  "You are being accessed through the Vercel AI Gateway VS Code extension. The user is interacting with you via VS Code's chat interface.";

export const ERROR_MESSAGES = {
  AUTH_FAILED:
    "Failed to authenticate with Vercel AI Gateway. Please try again.",
  API_KEY_NOT_FOUND: "Vercel AI Gateway API key not found",
  VERCEL_CLI_NOT_LOGGED_IN:
    "Vercel CLI not logged in. Please run `vercel login` first.",
  MODELS_FETCH_FAILED: "Failed to fetch models from Vercel AI Gateway",
} as const;
