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
 *
 * Persistence: When provided with a Memento, state survives extension restarts.
 */

import type * as vscode from "vscode";
import { logger } from "../logger";
import { computeNormalizedDigest } from "../utils/digest";

const CONVERSATION_SUMMARY_TAG = /<conversation-summary>/i;

/**
 * Extract text from a message content part.
 * Handles both LanguageModelTextPart instances ({value: string})
 * and serialized text parts ({type: "text", text: string}).
 */
function extractPartText(part: unknown): string | undefined {
  if (typeof part !== "object" || part === null) return undefined;
  // LanguageModelTextPart: has .value
  if (
    "value" in part &&
    typeof (part as { value: unknown }).value === "string"
  ) {
    return (part as { value: string }).value;
  }
  // Serialized text part: has .type === "text" and .text
  if (
    "type" in part &&
    (part as { type: unknown }).type === "text" &&
    "text" in part &&
    typeof (part as { text: unknown }).text === "string"
  ) {
    return (part as { text: string }).text;
  }
  return undefined;
}

/**
 * Detect whether a messages array contains a Copilot summarization tag.
 * After summarization, Copilot inserts a `<conversation-summary>` user message
 * that persists at the start of the array on all subsequent turns.
 */
export function hasSummarizationTag(
  messages: readonly vscode.LanguageModelChatMessage[],
): boolean {
  // LanguageModelChatMessageRole.User = 1
  const USER_ROLE = 1;
  for (const msg of messages) {
    if (msg.role !== USER_ROLE) continue;
    for (const part of msg.content) {
      const text = extractPartText(part);
      if (text !== undefined && CONVERSATION_SUMMARY_TAG.test(text)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * A known conversation state from an API response.
 */
export interface KnownConversationState {
  /** Ordered hashes of messages in this conversation */
  messageHashes: string[];
  /** Actual total input tokens from API */
  actualTokens: number;
  /** Sequence estimate before API call (for rolling correction) */
  lastSequenceEstimate?: number;
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
 * Persisted state schema for Memento storage.
 */
interface PersistedConversationState {
  version: number;
  timestamp: number;
  entries: Array<{
    key: string;
    state: KnownConversationState;
  }>;
}

const STORAGE_KEY = "conversationStateTracker.v1";
const STORAGE_VERSION = 1;

/**
 * Tracks known conversation states for delta-based token estimation.
 */
export class ConversationStateTracker {
  /** Most recent known state per conversation key */
  private knownStates = new Map<string, KnownConversationState>();
  private accessOrder: string[] = [];
  private readonly maxEntries = 100;
  private readonly ttlMs = 60 * 60 * 1000;
  private readonly memento: vscode.Memento | undefined;
  private saveDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(memento?: vscode.Memento) {
    this.memento = memento;
    if (memento) {
      this.loadFromStorage();
    }
  }

  // NOTE: computeKey() removed - family-only keying (RFC 00054)

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
    _conversationId?: string, // deprecated, ignored (RFC 00054)
    sequenceEstimate?: number,
    summarizationDetected?: boolean,
  ): void {
    void _conversationId;
    this.cleanupStale();
    const messageHashes = messages.map((m) => computeNormalizedDigest(m));
    const key = modelFamily; // Family-only keying (RFC 00054)

    // RFC 047 Phase 4b: When summarization is detected, omit lastSequenceEstimate
    // from the state. This clears the rolling correction so getAdjustment()
    // returns 0 until a new estimate-vs-actual pair is established post-summarization.
    const state: KnownConversationState = summarizationDetected
      ? {
          messageHashes,
          actualTokens,
          modelFamily,
          timestamp: Date.now(),
        }
      : {
          messageHashes,
          actualTokens,
          ...(sequenceEstimate !== undefined
            ? { lastSequenceEstimate: sequenceEstimate }
            : {}),
          modelFamily,
          timestamp: Date.now(),
        };

    this.touchKey(key);
    this.evictIfNeeded(key);
    this.knownStates.set(key, state);

    // NOTE: Dual-write logic removed (RFC 00054) - family-only keying now

    this.scheduleSave();

    if (summarizationDetected) {
      logger.info(
        `[ConversationState] Summarization guard: cleared rolling correction ` +
          `for family key "${modelFamily}"`,
      );
    }

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
    _conversationId?: string, // deprecated, ignored (RFC 00054)
  ): ConversationLookupResult {
    void _conversationId;
    this.cleanupStale();
    const key = modelFamily; // Family-only keying (RFC 00054)
    const state = this.knownStates.get(key);
    if (!state) {
      return { type: "none" };
    }
    this.touchKey(key);

    const currentHashes = messages.map((m) => computeNormalizedDigest(m));

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
    _conversationId?: string, // deprecated, ignored (RFC 00054)
  ): KnownConversationState | undefined {
    void _conversationId;
    return this.knownStates.get(modelFamily);
  }

  /**
   * Clear all known states (including persisted storage).
   */
  clear(): void {
    this.knownStates.clear();
    this.accessOrder = [];
    if (this.memento) {
      void this.memento.update(STORAGE_KEY, undefined);
    }
  }

  /**
   * Get the number of stored entries (for testing/debugging).
   */
  size(): number {
    return this.knownStates.size;
  }

  private touchKey(key: string): void {
    const index = this.accessOrder.indexOf(key);
    if (index !== -1) {
      this.accessOrder.splice(index, 1);
    }
    this.accessOrder.push(key);
  }

  private evictIfNeeded(key: string): void {
    while (this.knownStates.size >= this.maxEntries) {
      const oldest = this.accessOrder.shift();
      if (!oldest) {
        break;
      }
      if (!this.knownStates.has(oldest)) {
        continue;
      }
      if (oldest === key) {
        continue;
      }
      this.knownStates.delete(oldest);
      break;
    }
  }

  private cleanupStale(): void {
    const now = Date.now();
    let changed = false;
    for (const [key, state] of this.knownStates) {
      if (now - state.timestamp > this.ttlMs) {
        this.knownStates.delete(key);
        const index = this.accessOrder.indexOf(key);
        if (index !== -1) {
          this.accessOrder.splice(index, 1);
        }
        changed = true;
      }
    }
    if (changed) {
      this.scheduleSave();
    }
  }

  /**
   * Load state from Memento storage.
   */
  private loadFromStorage(): void {
    if (!this.memento) return;

    try {
      const stored = this.memento.get<PersistedConversationState>(STORAGE_KEY);
      if (!stored || stored.version !== STORAGE_VERSION) {
        logger.debug("[ConversationState] No valid stored state found");
        return;
      }

      // Filter out stale entries during load
      const now = Date.now();
      let loadedCount = 0;
      for (const entry of stored.entries) {
        if (now - entry.state.timestamp <= this.ttlMs) {
          this.knownStates.set(entry.key, entry.state);
          this.accessOrder.push(entry.key);
          loadedCount++;
        }
      }

      logger.info(
        `[ConversationState] Loaded ${loadedCount.toString()} entries from storage`,
      );
    } catch (error) {
      logger.warn("[ConversationState] Failed to load from storage", error);
    }
  }

  /**
   * Save state to Memento storage (debounced).
   */
  private scheduleSave(): void {
    if (!this.memento) return;

    // Debounce saves to avoid excessive writes
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(() => {
      void this.saveToStorage();
    }, 1000);
  }

  /**
   * Persist current state to Memento.
   */
  private async saveToStorage(): Promise<void> {
    if (!this.memento) return;

    try {
      const entries: PersistedConversationState["entries"] = [];
      for (const key of this.accessOrder) {
        const state = this.knownStates.get(key);
        if (state) {
          entries.push({ key, state });
        }
      }

      const persisted: PersistedConversationState = {
        version: STORAGE_VERSION,
        timestamp: Date.now(),
        entries,
      };

      await this.memento.update(STORAGE_KEY, persisted);
      logger.debug(
        `[ConversationState] Saved ${entries.length.toString()} entries to storage`,
      );
    } catch (error) {
      logger.warn("[ConversationState] Failed to save to storage", error);
    }
  }
}
