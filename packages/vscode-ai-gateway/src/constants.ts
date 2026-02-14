export const EXTENSION_ID = "vercel.ai";
export const VENDOR_ID = "vercel";
export const VSCODE_EXTENSION_ID = "vercel.vscode-ai-gateway";
export const DEFAULT_BASE_URL = "https://ai-gateway.vercel.sh";
export const MODELS_ENDPOINT = "/v1/models";
export const MODELS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const ENRICHMENT_ENDPOINT_PATTERN = "/v1/models";
export const ENRICHMENT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const TOKEN_REFRESH_MARGIN = 15 * 60 * 1000; // 15 minutes
export const LAST_SELECTED_MODEL_KEY = "vercel.ai.lastSelectedModel";

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
  // Friendly auth errors with actionable guidance
  AUTH_KEY_MISSING:
    "No API key configured. Set up authentication to use Vercel AI Gateway.",
  AUTH_KEY_INVALID:
    "Your API key was rejected by the server. Please check your authentication settings.",
  AUTH_KEY_EXPIRED:
    "Your authentication has expired. Please re-authenticate to continue.",
  // Status-specific error messages with actionable guidance
  MODEL_NOT_FOUND:
    "Model not found. Check that the model name is correct and available in your Vercel AI Gateway.",
  RATE_LIMITED: "Rate limit exceeded. Please wait a moment and try again.",
  SERVER_ERROR:
    "The AI Gateway encountered an internal error. Please try again in a few moments.",
  SERVICE_UNAVAILABLE:
    "The AI Gateway is temporarily unavailable. Please try again shortly.",
  NETWORK_ERROR:
    "Unable to reach the AI Gateway. Check your internet connection and try again.",
  // Stream-level error messages
  CONTENT_FILTERED:
    "The response was filtered due to content policy. Try rephrasing your request.",
  RESPONSE_TRUNCATED:
    "The response was truncated because it reached the maximum output length. The model's output may be incomplete.",
  RESPONSE_FAILED: "The model failed to generate a response. Please try again.",
  // Model list
  MODELS_UNAVAILABLE:
    "Unable to load models from Vercel AI Gateway. The model picker may be empty until connectivity is restored.",
} as const;
