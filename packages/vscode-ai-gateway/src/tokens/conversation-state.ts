/**
 * Conversation State Tracker for Delta Token Estimation
 *
 * Tracks known conversation states from API responses.
 * When we see a conversation that extends a known state, we use:
 *   knownTotal + tiktoken(new messages only)
 *
 * This is much more accurate than calibration because:
 * - The bulk of the context has known-accurate token count
 * - We only estimate the delta (typically one new message)
 * - Error is bounded to a single message, not the entire context
 */

import * as crypto from "node:crypto";
import type * as vscode from "vscode";
import { logger } from "../logger";

/**
 * A known conversation state from an API response.
 */
export interface KnownConversationState {
  /** Ordered hashes of messages in this conversation */
  messageHashes: string[];
  /** Actual total input tokens from API */
  actualTokens: number;
  /** Model family this was measured for */
  modelFamily: string;
  /** When this was recorded */
  timestamp: number;
}

/**
 * Result of looking up conversation state.
 */
export interface ConversationLookupResult {
  /** Whether we found an exact or prefix match */
  type: "exact" | "prefix" | "none";
  /** Known token count (for exact/prefix match) */
  knownTokens?: number;
  /** Number of new messages beyond the known prefix (for prefix match) */
  newMessageCount?: number;
  /** Indices of new messages (for prefix match) */
  newMessageIndices?: number[];
}

/**
 * Tracks known conversation states for delta-based token estimation.
 */
export class ConversationStateTracker {
  /** Most recent known state per conversation key */
  private knownStates = new Map<string, KnownConversationState>();

  private computeKey(modelFamily: string, conversationId?: string): string {
    return conversationId ? `${modelFamily}:${conversationId}` : modelFamily;
  }

  /**
   * Record actual token count from an API response.
   *
   * @param messages - The messages that were sent
   * @param modelFamily - Model family identifier
   * @param actualTokens - Actual input tokens from API response
   */
  recordActual(
    messages: readonly vscode.LanguageModelChatMessage[],
    modelFamily: string,
    actualTokens: number,
    conversationId?: string,
  ): void {
    const messageHashes = messages.map((m) => this.hashMessage(m));
    const key = this.computeKey(modelFamily, conversationId);

    const state: KnownConversationState = {
      messageHashes,
      actualTokens,
      modelFamily,
      timestamp: Date.now(),
    };

    this.knownStates.set(key, state);

    logger.debug(
      `[ConversationState] Recorded: ${messageHashes.length.toString()} messages, ` +
        `${actualTokens.toString()} tokens (${modelFamily}) key=${key}`,
    );
  }

  /**
   * Look up whether we have knowledge about this conversation.
   *
   * Returns:
   * - "exact": Messages exactly match a known state
   * - "prefix": Known state is a prefix of current messages
   * - "none": No matching state found
   */
  lookup(
    messages: readonly vscode.LanguageModelChatMessage[],
    modelFamily: string,
    conversationId?: string,
  ): ConversationLookupResult {
    const key = this.computeKey(modelFamily, conversationId);
    const state = this.knownStates.get(key);
    if (!state) {
      return { type: "none" };
    }

    const currentHashes = messages.map((m) => this.hashMessage(m));

    // Check for exact match
    if (
      currentHashes.length === state.messageHashes.length &&
      currentHashes.every((h, i) => h === state.messageHashes[i])
    ) {
      logger.trace(
        `[ConversationState] Exact match: ${state.actualTokens.toString()} tokens`,
      );
      return {
        type: "exact",
        knownTokens: state.actualTokens,
      };
    }

    // Check for prefix match (known state is prefix of current)
    if (
      currentHashes.length > state.messageHashes.length &&
      state.messageHashes.every((h, i) => h === currentHashes[i])
    ) {
      const newMessageCount = currentHashes.length - state.messageHashes.length;
      const newMessageIndices = Array.from(
        { length: newMessageCount },
        (_, i) => state.messageHashes.length + i,
      );

      logger.trace(
        `[ConversationState] Prefix match: ${state.actualTokens.toString()} known + ` +
          `${newMessageCount.toString()} new messages`,
      );

      return {
        type: "prefix",
        knownTokens: state.actualTokens,
        newMessageCount,
        newMessageIndices,
      };
    }

    // No match - conversation has changed (e.g., regeneration, branch)
    logger.trace(
      `[ConversationState] No match: conversation diverged from known state`,
    );
    return { type: "none" };
  }

  /**
   * Get the known state for a model family.
   */
  getState(
    modelFamily: string,
    conversationId?: string,
  ): KnownConversationState | undefined {
    const key = this.computeKey(modelFamily, conversationId);
    return this.knownStates.get(key);
  }

  /**
   * Clear all known states.
   */
  clear(): void {
    this.knownStates.clear();
  }

  /**
   * Hash a message for comparison.
   */
  private hashMessage(message: vscode.LanguageModelChatMessage): string {
    const content = {
      role: message.role,
      name: message.name,
      parts: this.serializeParts(message.content),
    };
    return crypto
      .createHash("sha256")
      .update(JSON.stringify(content))
      .digest("hex");
  }

  /**
   * Serialize message parts for hashing.
   */
  private serializeParts(
    content: vscode.LanguageModelChatMessage["content"],
  ): unknown[] {
    const parts: unknown[] = [];
    for (const part of content) {
      if ("value" in part && typeof part.value === "string") {
        // TextPart
        parts.push({ type: "text", value: part.value });
      } else if ("data" in part && "mimeType" in part) {
        // DataPart - hash the data instead of including it
        const data = part.data;
        const dataHash = crypto.createHash("sha256").update(data).digest("hex");
        parts.push({
          type: "data",
          mimeType: part.mimeType,
          dataHash,
          dataLen: data.length,
        });
      } else if ("name" in part && "callId" in part) {
        // ToolCallPart or ToolResultPart
        parts.push({
          type: "toolResult" in part ? "toolResult" : "toolCall",
          name: part.name,
          callId: part.callId,
        });
      } else {
        parts.push({ type: "unknown" });
      }
    }
    return parts;
  }
}
