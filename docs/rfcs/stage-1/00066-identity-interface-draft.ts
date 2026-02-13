/**
 * ConversationIdentityProvider — Interface Draft
 *
 * RFC 00066: Interface-First API Alignment
 * Goal: design-identity-interface
 *
 * This interface abstracts conversation identity so that:
 * 1. The current stateful-marker.ts workaround can implement it
 * 2. The chatSessionsProvider proposal can implement it when stable
 * 3. Consumers (status-bar, persistence, investigation logger) don't care which
 *
 * Design Decisions:
 * - Identity is a string (UUID for workaround, Uri.toString() for chatSessionsProvider)
 * - Identity is available before the first request (resolve() can be called eagerly)
 * - Persistence is NOT part of this interface (separate concern)
 * - prompt_cache_key is NOT part of this interface (consumers derive it)
 * - Session/request identity are separate from conversation identity
 */

import type { LanguageModelChatMessage } from "vscode";

// =============================================================================
// Core Types
// =============================================================================

/**
 * Opaque conversation identity. Stable across turns within a single conversation.
 *
 * Workaround impl: UUID string (from stateful marker sessionId or randomUUID())
 * chatSessionsProvider impl: ChatSessionItem.resource.toString()
 */
export type ConversationId = string & { readonly __brand: unique symbol };

/**
 * Metadata about how the identity was resolved.
 * Useful for diagnostics and logging.
 */
export interface IdentityResolution {
  /** The resolved conversation identity */
  readonly conversationId: ConversationId;

  /** How the identity was obtained */
  readonly source:
    | "marker"              // Recovered from a stateful marker in message history
    | "session-provider"    // Provided by chatSessionsProvider API
    | "generated";          // Freshly generated (first turn, no prior context)

  /** The response ID from the last turn (if recovered from marker) */
  readonly lastResponseId?: string;

  /** Whether this is a new conversation (no prior turns) */
  readonly isNew: boolean;
}

// =============================================================================
// Provider Interface
// =============================================================================

/**
 * Resolves conversation identity from available context.
 *
 * Implementations:
 * 1. StatefulMarkerIdentityProvider — scans message history for markers (current workaround)
 * 2. ChatSessionIdentityProvider — delegates to chatSessionsProvider API (future)
 *
 * The provider is stateless — it resolves identity from the context provided.
 * It does NOT manage lifecycle, persistence, or caching.
 */
export interface ConversationIdentityProvider {
  /**
   * Resolve the conversation identity from the given context.
   *
   * For the workaround: scans messages backward for a stateful marker,
   * falls back to generating a new UUID.
   *
   * For chatSessionsProvider: extracts identity from ChatSessionContext
   * available in the ChatContext (participant-side) or from the session
   * resource URI.
   *
   * @param messages - The chat message history (may contain stateful markers)
   * @param modelId - The model being used (for marker filtering)
   * @returns The resolved identity with metadata
   */
  resolve(
    messages: readonly LanguageModelChatMessage[],
    modelId: string,
  ): IdentityResolution;

  /**
   * The name of this provider implementation (for diagnostics).
   * e.g., "stateful-marker", "chat-session-provider"
   */
  readonly name: string;
}

// =============================================================================
// Marker Emitter (Workaround-specific)
// =============================================================================

/**
 * Emits identity markers into the response stream.
 *
 * This is ONLY needed for the stateful-marker workaround.
 * When chatSessionsProvider is available, identity is managed by VS Code
 * and no markers need to be emitted.
 *
 * Separated from ConversationIdentityProvider because:
 * - Not all implementations need to emit markers
 * - Emission happens in the stream adapter, resolution happens in the provider
 * - The chatSessionsProvider implementation would be a no-op
 */
export interface IdentityMarkerEmitter {
  /**
   * Create the marker data to embed in the response stream.
   * Returns undefined if this implementation doesn't use markers.
   *
   * @param conversationId - The conversation identity to embed
   * @param modelId - The model that produced the response
   * @param responseId - The API response ID
   * @returns Encoded marker data + MIME type, or undefined
   */
  createMarker(
    conversationId: ConversationId,
    modelId: string,
    responseId: string,
  ): { data: Uint8Array; mimeType: string } | undefined;
}

// =============================================================================
// Composite (Convenience)
// =============================================================================

/**
 * Combined identity service that provides both resolution and emission.
 * This is what most consumers will use.
 */
export interface ConversationIdentityService
  extends ConversationIdentityProvider {
  /**
   * The marker emitter, if this implementation uses markers.
   * Undefined for implementations that don't need markers (e.g., chatSessionsProvider).
   */
  readonly markerEmitter: IdentityMarkerEmitter | undefined;
}

// =============================================================================
// Design Notes
// =============================================================================

/**
 * DESIGN NOTE: Why not include persistence?
 *
 * The chatSessionsProvider API has ChatSessionItem.metadata for arbitrary JSON,
 * which could replace our PersistedAgentState. However:
 * - Our persistence needs (token counts, turn tracking) are orthogonal to identity
 * - The persistence store has its own lifecycle (TTL, eviction, migration)
 * - Coupling persistence to identity would make the interface harder to test
 * - The persistence layer already uses conversationId as its key — it just needs
 *   the string, not the full identity service
 *
 * DESIGN NOTE: Why string and not Uri?
 *
 * chatSessionsProvider uses Uri as identity (ChatSessionItem.resource).
 * Our workaround uses UUID strings. Using string as the common type:
 * - Avoids importing vscode types in the interface (testability)
 * - Uri.toString() is a lossless conversion
 * - Consumers that need Uri can parse it; consumers that need string already have it
 * - The branded type prevents accidental string mixing
 *
 * DESIGN NOTE: Provider-side vs participant-side
 *
 * Our extension is an LM provider (LanguageModelChat), not a chat participant.
 * chatSessionsProvider requires ChatParticipant for registerChatSessionContentProvider.
 * This means:
 * - If we stay provider-only: we can't use chatSessionsProvider directly
 * - If we add a participant: we can use chatSessionsProvider but gain complexity
 * - The interface abstracts this: StatefulMarkerIdentityProvider works provider-side,
 *   ChatSessionIdentityProvider would work participant-side
 * - A hybrid approach is possible: use chatSessionsProvider when available (via
 *   ChatContext.chatSessionContext), fall back to stateful markers otherwise
 *
 * DESIGN NOTE: First-turn identity
 *
 * Current behavior: first turn gets randomUUID(), identity stabilizes after
 * first response (when the marker is emitted and can be recovered).
 *
 * chatSessionsProvider behavior: identity is available immediately via
 * ChatSessionItem.resource (the session exists before any requests).
 *
 * The interface supports both: resolve() returns isNew=true for first turns,
 * and the conversationId is still valid (just freshly generated).
 * Consumers should not assume identity changes between turns.
 */
