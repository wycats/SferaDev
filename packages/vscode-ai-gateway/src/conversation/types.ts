/**
 * Extension-local legacy types.
 *
 * Shared conversation types live in @vercel/conversation.
 * This file contains only extension-specific types that don't belong in the shared package.
 */

/**
 * Legacy user↔assistant exchange entry retained for migration/backward compatibility.
 */
export interface TurnEntry {
  type: "turn";
  /** Sequential turn number (1-based). */
  turnNumber: number;
  /** Timestamp (ms) when the turn was recorded. */
  timestamp: number;
  /** Short characterization of what happened (from gpt-4o-mini). */
  characterization?: string;
  /** Output token count for this turn. */
  outputTokens: number;
  /** Subagents spawned during this turn (by conversationId). */
  subagentIds: string[];
  /** Whether the turn is currently streaming. */
  streaming: boolean;
}
