/**
 * ThinkingContentProvider — Interface Draft
 *
 * RFC 00066: Interface-First API Alignment
 * Goal: design-thinking-interface
 *
 * Unlike identity and tokens, thinking is ALREADY using the proposed API
 * (LanguageModelThinkingPart) at runtime. The interface here formalizes
 * the dual streaming/persistence pattern and prepares for the API to
 * stabilize into the official LanguageModelResponsePart union.
 *
 * Design Decisions:
 * - Interface covers BOTH streaming emission and persistence
 * - Buffering is an implementation detail (not in the interface)
 * - Provider-side emission (LanguageModelThinkingPart) is the primary path
 * - Participant-side (ChatResponseThinkingProgressPart) is a future alternative
 * - Thinking token counts are exposed separately (they're real but excluded from input estimation)
 * - Capability detection is part of the interface
 */

// =============================================================================
// Core Types
// =============================================================================

/**
 * A thinking content block from a model's reasoning process.
 *
 * This is our internal representation — independent of VS Code's
 * LanguageModelThinkingPart or the DataPart('thinking') persistence format.
 */
export interface ThinkingBlock {
  /** Unique identifier for this thinking sequence */
  readonly id: string;

  /** The thinking/reasoning text content */
  readonly text: string;

  /** Optional metadata (model-specific) */
  readonly metadata?: Readonly<Record<string, unknown>>;

  /** Token count for this thinking block (if known from API) */
  readonly tokens?: number;
}

// =============================================================================
// Provider Interface
// =============================================================================

/**
 * Handles thinking content emission and persistence.
 *
 * Implementations:
 * 1. ThinkingPartEmitter — uses LanguageModelThinkingPart (current, provider-side)
 * 2. ChatResponseThinkingEmitter — uses ChatResponseThinkingProgressPart (future, participant-side)
 *
 * The provider handles the dual nature of thinking:
 * - Streaming: emit thinking parts during response for live display
 * - Persistence: encode thinking data for recovery from message history
 */
export interface ThinkingContentProvider {
  /**
   * Whether thinking content is supported in the current environment.
   *
   * Current impl: checks `vscode.LanguageModelThinkingPart !== undefined`
   * Future: always true when languageModelThinkingPart is stable
   */
  readonly isSupported: boolean;

  /**
   * Create a streaming thinking part for emission in the response stream.
   *
   * Current impl: `new LanguageModelThinkingPart(text, id)`
   * Future: same (LanguageModelThinkingPart becomes stable)
   *
   * @param text - The thinking text content
   * @param id - Unique identifier for this thinking sequence
   * @returns The part to emit, or undefined if not supported
   */
  createStreamingPart(text: string, id: string): unknown | undefined; // LanguageModelThinkingPart at runtime

  /**
   * Create a persistence part for encoding thinking data in message history.
   *
   * Current impl: `new LanguageModelDataPart(encodeThinkingData(...), "thinking")`
   * Future: may not be needed if LanguageModelThinkingPart persists natively
   *
   * @param block - The complete thinking block to persist
   * @returns The data part to emit, or undefined if persistence is handled natively
   */
  createPersistencePart(
    block: ThinkingBlock,
  ): { data: Uint8Array; mimeType: string } | undefined;

  /**
   * Recover thinking blocks from message history.
   *
   * Current impl: `findThinkingData(messages)` — scans DataPart('thinking')
   * Future: may scan LanguageModelThinkingPart directly in message content
   *
   * @param messages - Chat message history
   * @returns Recovered thinking blocks in order of appearance
   */
  recoverFromHistory(
    messages: readonly unknown[], // LanguageModelChatMessage[]
  ): ThinkingBlock[];

  /** The name of this provider (for diagnostics) */
  readonly name: string;
}

// =============================================================================
// Design Notes
// =============================================================================

/**
 * DESIGN NOTE: Why this interface is thinner than identity/tokens
 *
 * Thinking is the LEAST abstracted of the three interfaces because:
 * 1. We already use the proposed API (LanguageModelThinkingPart) directly
 * 2. The API is at version 1 and relatively stable
 * 3. The class exists at runtime without enabledApiProposals
 * 4. There's no "workaround vs proposal" gap — we use the proposal
 *
 * The main value of this interface is:
 * - Formalizing the streaming/persistence duality
 * - Preparing for when ThinkingPart enters the stable API
 * - Abstracting the DataPart('thinking') persistence hack
 *
 * DESIGN NOTE: Streaming vs persistence
 *
 * Thinking has a unique dual representation:
 * - Streaming: LanguageModelThinkingPart emitted during response (for live UI)
 * - Persistence: DataPart('thinking') emitted at reasoning done (for history recovery)
 *
 * When LanguageModelThinkingPart becomes stable and enters the
 * LanguageModelResponsePart union, VS Code will persist it natively.
 * At that point, createPersistencePart() returns undefined and
 * recoverFromHistory() scans ThinkingPart in message content instead
 * of DataPart('thinking').
 *
 * DESIGN NOTE: Provider-side vs participant-side
 *
 * Provider-side (what we do): emit LanguageModelThinkingPart in the response stream.
 * Participant-side (future): emit ChatResponseThinkingProgressPart via
 * ChatResponseStream.thinkingProgress(thinkingDelta).
 *
 * The participant-side API adds a task callback pattern for streaming thinking
 * content progressively. This is richer but requires participant registration.
 *
 * For now, provider-side is correct — we're an LM provider, not a participant.
 * If we add participant registration (for chatSessionsProvider), we could
 * switch to participant-side thinking emission.
 *
 * DESIGN NOTE: Thinking tokens
 *
 * Thinking tokens are real tokens consumed by the model but are currently
 * excluded from input token estimation (isMetadataMime returns true for
 * 'thinking' MIME). This is correct because:
 * - Thinking tokens are OUTPUT tokens (model generates them)
 * - They don't count toward input token limits
 * - But they DO affect billing and total context
 *
 * ThinkingBlock.tokens exposes the count when available from the API,
 * allowing consumers to display thinking token usage separately.
 *
 * DESIGN NOTE: Buffering
 *
 * The 20-char buffer threshold in stream-adapter.ts is a UX optimization
 * to avoid emitting many tiny ThinkingParts. This is an implementation
 * detail of the stream adapter, not part of the interface.
 */
