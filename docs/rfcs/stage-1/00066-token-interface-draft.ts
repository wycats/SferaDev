/**
 * TokenCountProvider — Interface Draft
 *
 * RFC 00066: Interface-First API Alignment
 * Goal: design-token-interface
 *
 * This interface abstracts token counting so that:
 * 1. The current counter.ts + status-bar.ts workaround can implement it
 * 2. The ChatResultUsage proposal can implement it when stable
 * 3. Consumers (status-bar, agent-tree, diagnostics) don't care which
 *
 * Design Decisions:
 * - Covers BOTH estimation (pre-flight) and actuals (post-response)
 * - Category breakdown uses absolute counts (more useful) with percentage derivable
 * - Streaming estimation is part of the interface (not just final usage)
 * - Delta estimation is an implementation detail (not in the interface)
 * - maxInputTokens is model metadata, not part of token usage
 * - Push model (reporter) for actuals, pull model (estimator) for pre-flight
 */

// =============================================================================
// Core Types
// =============================================================================

/**
 * Token usage from a completed request.
 * This is the "actuals" — what the API reported.
 *
 * Workaround impl: OpenResponses API Usage object
 * ChatResultUsage impl: ChatResultUsage from chatParticipantAdditions
 */
export interface TokenUsageReport {
  /** Total prompt/input tokens used */
  readonly promptTokens: number;

  /** Total completion/output tokens generated */
  readonly completionTokens: number;

  /**
   * Optional breakdown of prompt tokens by category.
   * Categories are extensible strings (e.g., "System", "Context", "Conversation", "Tools").
   *
   * Workaround impl: computed from counter.ts category methods
   * ChatResultUsage impl: directly from promptTokenDetails
   */
  readonly promptBreakdown?: readonly TokenCategoryDetail[];
}

/**
 * Token usage breakdown by category.
 *
 * Uses absolute counts (not percentages) because:
 * - Our display needs absolute counts for formatting
 * - Percentages are trivially derivable from counts + total
 * - ChatResultPromptTokenDetail uses percentages, but we can convert
 */
export interface TokenCategoryDetail {
  /** Category name (e.g., "System", "Context", "Conversation", "Tools") */
  readonly category: string;

  /** Human-readable label (e.g., "System prompt", "Attached files") */
  readonly label: string;

  /** Absolute token count for this category */
  readonly tokens: number;
}

/**
 * Pre-flight token estimate for a request about to be sent.
 * This is the "estimation" — computed locally before the API call.
 */
export interface TokenEstimate {
  /** Total estimated input tokens */
  readonly total: number;

  /** Whether this is a full re-estimate or delta-anchored */
  readonly isAnchored: boolean;

  /** Breakdown by category (if available) */
  readonly breakdown?: readonly TokenCategoryDetail[];
}

// =============================================================================
// Provider Interfaces
// =============================================================================

/**
 * Estimates token counts for messages before sending to the API.
 *
 * Implementations:
 * 1. AiTokenizerEstimator — uses ai-tokenizer with model-family dispatch (current)
 * 2. NativeEstimator — could use VS Code's built-in countTokens (if accurate enough)
 *
 * The estimator is stateless — it computes from the inputs provided.
 */
export interface TokenEstimator {
  /**
   * Estimate total input tokens for a set of messages.
   *
   * @param messages - Chat messages to estimate
   * @param modelFamily - Model family for encoding selection
   * @param options - Additional context (tools, system prompt)
   */
  estimateInput(
    messages: readonly unknown[], // LanguageModelChatMessage[]
    modelFamily: string,
    options?: {
      tools?: readonly { name: string; description?: string; inputSchema?: unknown }[];
      systemPrompt?: string;
    },
  ): TokenEstimate;

  /** The name of this estimator (for diagnostics) */
  readonly name: string;
}

/**
 * Reports actual token usage from API responses.
 *
 * Implementations:
 * 1. OpenResponsesUsageReporter — extracts from OpenResponses API Usage object (current)
 * 2. ChatResultUsageReporter — extracts from ChatResultUsage (future, participant-side)
 *
 * The reporter converts API-specific usage formats to our common TokenUsageReport.
 */
export interface TokenUsageReporter {
  /**
   * Convert API-specific usage data to a common report.
   *
   * @param apiUsage - The raw usage data from the API (type varies by implementation)
   * @param estimate - The pre-flight estimate (for computing breakdown if API doesn't provide one)
   */
  report(apiUsage: unknown, estimate?: TokenEstimate): TokenUsageReport;

  /** The name of this reporter (for diagnostics) */
  readonly name: string;
}

// =============================================================================
// Composite Service
// =============================================================================

/**
 * Combined token counting service.
 * Provides both estimation and reporting in a single interface.
 */
export interface TokenCountService {
  readonly estimator: TokenEstimator;
  readonly reporter: TokenUsageReporter;
}

// =============================================================================
// Design Notes
// =============================================================================

/**
 * DESIGN NOTE: Why separate estimator and reporter?
 *
 * Estimation (pre-flight) and reporting (post-response) are fundamentally
 * different operations:
 * - Estimation is synchronous, local, approximate
 * - Reporting is asynchronous, from the API, exact
 * - They have different inputs (messages vs API response)
 * - They may have different implementations (ai-tokenizer vs ChatResultUsage)
 *
 * Separating them allows:
 * - Testing estimation without API calls
 * - Swapping reporters without changing estimation
 * - Using estimation as fallback when API doesn't report usage
 *
 * DESIGN NOTE: Why absolute counts instead of percentages?
 *
 * ChatResultPromptTokenDetail uses percentages (0-100). We use absolute counts because:
 * - Our display formats need absolute counts (e.g., "52.3k tokens")
 * - Percentages lose precision (rounding) and can't reconstruct absolutes
 * - Converting counts→percentages is trivial: (count / total) * 100
 * - Converting percentages→counts requires the total (which may not be available)
 *
 * When implementing ChatResultUsageReporter, we convert:
 *   tokens = Math.round(promptTokens * percentageOfPrompt / 100)
 *
 * DESIGN NOTE: Why not include maxInputTokens?
 *
 * maxInputTokens is a model property, not a token usage property.
 * It's available from LanguageModelChatInformation.maxInputTokens.
 * Including it in TokenUsageReport would couple token counting to model metadata.
 * Consumers that need the limit can get it from the model directly.
 *
 * DESIGN NOTE: Delta estimation
 *
 * Our current system tracks estimatedDeltaTokens (new messages only, anchored
 * to last actual input tokens). This is an optimization for accurate streaming
 * display — not a fundamental token counting concept.
 *
 * The interface exposes this via TokenEstimate.isAnchored:
 * - isAnchored=true: estimate is delta from known baseline (more accurate)
 * - isAnchored=false: full re-estimate from scratch (less accurate)
 *
 * The actual delta computation stays in the estimator implementation.
 *
 * DESIGN NOTE: Provider-side vs participant-side
 *
 * Same issue as identity: ChatResultUsage is participant-side (ChatResponseStream).
 * Our extension is provider-side. The interface abstracts this:
 * - OpenResponsesUsageReporter works provider-side (extracts from API response)
 * - ChatResultUsageReporter would work participant-side (extracts from ChatResultUsage)
 * - Both produce the same TokenUsageReport
 */
