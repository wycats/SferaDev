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

import { randomUUID } from "node:crypto";
import type * as vscode from "vscode";
import { logger } from "../logger";
import { computeNormalizedDigest, computeRawDigest } from "../utils/digest";
import { VSCODE_SYSTEM_ROLE } from "../provider/system-prompt";

const CONVERSATION_SUMMARY_TAG = /<conversation-summary>/i;
const SUMMARIZATION_SYSTEM_PROMPT_MARKER =
  "Your task is to create a comprehensive, detailed summary";

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
 * Detect if this request is a specific "Summary Generation" pass.
 * Copilot invokes a dedicated pass (with full history) to generate a summary.
 * This prompt is distinct from the normal agent prompt.
 */
export function isSummarizationGenerationPass(
  messages: readonly vscode.LanguageModelChatMessage[],
): boolean {
  for (const message of messages) {
    if (message.role === (VSCODE_SYSTEM_ROLE as any)) {
      for (const part of message.content) {
        const text = extractPartText(part);
        if (text && text.includes(SUMMARIZATION_SYSTEM_PROMPT_MARKER)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * A known conversation state from an API response.
 */
export interface KnownConversationState {
  /** Ordered hashes of messages in this conversation (Normalized) */
  messageHashes: string[];
  /** Raw hashes (for forensic drift detection) */
  rawHashes?: string[];
  /** Actual total input tokens from API */
  actualTokens: number;
  /** Sequence estimate before API call (for rolling correction) */
  lastSequenceEstimate?: number;
  /** Model family this was measured for */
  modelFamily: string;
  /** When this was recorded */
  timestamp: number;
  /** Stable conversation identifier (UUID) - survives across turns */
  conversationId?: string;
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
  /** Stable conversation identifier (from matched state) */
  conversationId?: string;
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
  /** Inverted index: MessageHash -> Set<ConversationID> */
  private messageIndex = new Map<string, Set<string>>();
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
   * Force immediate save of pending state.
   * Call this on extension deactivation.
   */
  dispose(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = undefined;
      void this.saveToStorage();
    }
  }

  /**
   * Helper to add a state to the inverted index.
   */
  private addToIndex(key: string, state: KnownConversationState): void {
    for (const hash of state.messageHashes) {
      let set = this.messageIndex.get(hash);
      if (!set) {
        set = new Set();
        this.messageIndex.set(hash, set);
      }
      set.add(key);
    }
  }

  /**
   * Helper to remove a state from the inverted index.
   */
  private removeFromIndex(key: string, state: KnownConversationState): void {
    for (const hash of state.messageHashes) {
      const set = this.messageIndex.get(hash);
      if (set) {
        set.delete(key);
        if (set.size === 0) {
          this.messageIndex.delete(hash);
        }
      }
    }
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
    sequenceEstimate?: number,
    summarizationDetected?: boolean,
  ): void {
    this.cleanupStale();
    const messageHashes = messages.map((m) => computeNormalizedDigest(m));
    const rawHashes = messages.map((m) => computeRawDigest(m));

    // Generate a unique key for this specific conversation state.
    // Using the last message hash helps ensuring uniqueness for different states
    // but we mix in length to be safe.
    const lastHash = messageHashes[messageHashes.length - 1] ?? "empty";
    const key = `${modelFamily}:${messageHashes.length}:${lastHash.substring(0, 16)}`;

    // Preserve conversationId from an existing prefix conversation, or generate new.
    // We use strict prefix matching (not set intersection) to avoid collisions.
    const prefixState = this.findPrefixConversation(messageHashes, modelFamily);

    if (!prefixState) {
      this.detectAndLogNearMiss(messageHashes, modelFamily);
    }

    const conversationId = prefixState?.conversationId ?? randomUUID();

    // RFC 047 Phase 4b: When summarization is detected, omit lastSequenceEstimate
    // from the state. This clears the rolling correction so getAdjustment()
    // returns 0 until a new estimate-vs-actual pair is established post-summarization.
    const state: KnownConversationState = summarizationDetected
      ? {
          messageHashes,
          rawHashes,
          actualTokens,
          modelFamily,
          timestamp: Date.now(),
          conversationId,
        }
      : {
          messageHashes,
          rawHashes,
          actualTokens,
          ...(sequenceEstimate !== undefined
            ? { lastSequenceEstimate: sequenceEstimate }
            : {}),
          modelFamily,
          timestamp: Date.now(),
          conversationId,
        };

    // If updating an existing key, clear its old index entries first
    const oldState = this.knownStates.get(key);
    if (oldState) {
      this.removeFromIndex(key, oldState);
    }

    this.touchKey(key);
    this.knownStates.set(key, state);
    this.addToIndex(key, state);
    this.evictIfNeeded(key);
    this.scheduleSave();

    logger.debug(
      `[ConversationState] Recorded state for key ${key} (${actualTokens} tokens)`,
    );
    logger.info(
      `[ConversationStateDebug] Indexed state: key=${key} hashes=${messageHashes.length} last5=${JSON.stringify(messageHashes.slice(-5))}`,
    );
  }

  /**
   * Look up whether we have knowledge about this conversation.
   *
   * Uses an Inverted Index (set intersection) to identify the conversation,
   * then verifies exact or prefix matching.
   */
  lookup(
    messages: readonly vscode.LanguageModelChatMessage[],
    modelFamily: string,
  ): ConversationLookupResult {
    this.cleanupStale();

    const currentNormalizedHashes = messages.map((m) =>
      computeNormalizedDigest(m),
    );

    logger.info(
      `[ConversationStateDebug] Lookup: hashes=${currentNormalizedHashes.length} last5=${JSON.stringify(currentNormalizedHashes.slice(-5))}`,
    );

    // 1. Identify candidate via Set Intersection
    const candidateState = this.identifyConversation(
      currentNormalizedHashes,
      modelFamily,
    );
    if (!candidateState) {
      return { type: "none" };
    }

    // Debug: Trace mismatches
    const { key, state } = candidateState;
    if (state.messageHashes.length !== currentNormalizedHashes.length) {
      // Only log if we expect a prefix match but maxCount != length
      // If state len=33, and we match 30...
      let mismatches = 0;
      const minLen = Math.min(
        state.messageHashes.length,
        currentNormalizedHashes.length,
        messages.length,
      );
      for (let i = 0; i < minLen; i++) {
        const stateHash = state.messageHashes[i]!;
        const currentHash = currentNormalizedHashes[i]!;
        if (stateHash !== currentHash) {
          mismatches++;
          if (mismatches <= 5) {
            logger.info(
              `[ConversationStateDebug] Hash Mismatch at index ${i}: State=${stateHash.substring(0, 8)} Input=${currentHash.substring(0, 8)}`,
            );
            // Log raw content of mismatching messages for forensic analysis
            const inputMsg = messages[i]!;
            const contentPreview = inputMsg.content
              .map((p) => {
                if ("value" in p)
                  return (p as { value: string }).value.substring(0, 100);
                return JSON.stringify(p).substring(0, 100);
              })
              .join(" | ");
            logger.info(
              `[ConversationStateDebug] Mismatch Input Content [${i}] (${inputMsg.role}): ${contentPreview}`,
            );
          }
        }
      }
      if (mismatches > 0) {
        logger.info(
          `[ConversationStateDebug] Total Mismatches vs Candidate: ${mismatches} / ${minLen}`,
        );
      }
    }

    // 2. Verify relationship using Atomic Set Intersection (RFC 00058)
    //
    // Instead of strict positional prefix matching (which fails when VS Code
    // regenerates the system prompt or reorders context), we use set intersection:
    //   - Build a set of known message hashes from the candidate state
    //   - Count how many current messages match known hashes
    //   - Messages NOT in the known set are "new" (need estimation)
    //
    // This tolerates:
    //   - System prompt drift (index 0 changes on every request)
    //   - Context injection changes (agents block, workspace instructions)
    //   - History compaction/reordering after reload

    const knownHashSet = new Set(state.messageHashes);
    const currentHashSet = new Set(currentNormalizedHashes);

    // Count how many of the KNOWN hashes appear in the current messages
    let matchedKnownCount = 0;
    for (const hash of state.messageHashes) {
      if (currentHashSet.has(hash)) {
        matchedKnownCount++;
      }
    }

    // Strict Inclusion Rule (Atomic Message Algebra Compliance):
    // To safely use the cached total tokens, we must ensure that ALL messages
    // contributing to that total are present in the current conversation.
    // Otherwise, we are counting "ghost tokens" from deleted/drifted messages
    // which cannot be subtracted (as we lack per-message granularity).
    //
    // We strictly require that the candidate state is a SUBSET of the current conversation.
    if (matchedKnownCount < state.messageHashes.length) {
      logger.info(
        `[ConversationStateDebug] Candidate rejected: strict inclusion failed. ${matchedKnownCount}/${state.messageHashes.length} known hashes matched.`,
      );
      return { type: "none" };
    }

    // Identify which current messages are NEW (not in the known set)
    const newMessageIndices: number[] = [];
    for (let i = 0; i < currentNormalizedHashes.length; i++) {
      const hash = currentNormalizedHashes[i];
      if (hash !== undefined && !knownHashSet.has(hash)) {
        newMessageIndices.push(i);
      }
    }

    // Check for exact match: all current hashes are known AND no new messages
    if (
      newMessageIndices.length === 0 &&
      currentNormalizedHashes.length === state.messageHashes.length
    ) {
      this.touchKey(key);
      logger.info(
        `[ConversationStateDebug] Exact match via set intersection: ${matchedKnownCount} hashes`,
      );
      const result: ConversationLookupResult = {
        type: "exact",
        knownTokens: state.actualTokens,
      };
      if (state.conversationId) {
        result.conversationId = state.conversationId;
      }
      return result;
    }

    // Prefix/superset match: current conversation contains all (or most) known
    // messages plus some new ones
    if (newMessageIndices.length > 0) {
      this.touchKey(key);
      logger.info(
        `[ConversationStateDebug] Set intersection match: ${matchedKnownCount}/${state.messageHashes.length} known, ${newMessageIndices.length} new messages at indices [${newMessageIndices.slice(0, 10).join(",")}]`,
      );
      const result: ConversationLookupResult = {
        type: "prefix",
        knownTokens: state.actualTokens,
        newMessageCount: newMessageIndices.length,
        newMessageIndices,
      };
      if (state.conversationId) {
        result.conversationId = state.conversationId;
      }
      return result;
    }

    // Edge case: current is a strict subset of the known state (e.g., after
    // history truncation). We can still use the known tokens as an upper bound,
    // but mark it as "exact" since we have no new messages to estimate.
    if (
      newMessageIndices.length === 0 &&
      currentNormalizedHashes.length < state.messageHashes.length
    ) {
      this.touchKey(key);
      logger.info(
        `[ConversationStateDebug] Subset match: ${currentNormalizedHashes.length} current ⊂ ${state.messageHashes.length} known`,
      );
      // Return as prefix with 0 new messages — the caller gets knownTokens
      // which is an overestimate, but better than pure estimation.
      const result: ConversationLookupResult = {
        type: "prefix",
        knownTokens: state.actualTokens,
        newMessageCount: 0,
        newMessageIndices: [],
      };
      if (state.conversationId) {
        result.conversationId = state.conversationId;
      }
      return result;
    }

    return { type: "none" };
  }

  private detectAndLogNearMiss(
    currentHashes: string[],
    modelFamily: string,
  ): void {
    const approximate = this.identifyConversation(currentHashes, modelFamily);
    if (!approximate) return;

    const { state: approxState, key: approxKey } = approximate;

    // 1. Minimum complexity threshold: Don't log for tiny conversations
    // where collisions or "near misses" are less statistically significant.
    if (approxState.messageHashes.length < 5) return;

    // 2. Overlap calculation
    const currentSet = new Set(currentHashes);
    let matchCount = 0;
    for (const h of approxState.messageHashes) {
      if (currentSet.has(h)) matchCount++;
    }
    const overlapRatio = matchCount / approxState.messageHashes.length;

    // 3. Significant overlap threshold (70%)
    // If we match 70% of a prior conversation but failed prefix check,
    // that's a notable event (likely a history mutation).
    if (overlapRatio < 0.7) return;

    // 4. Analyze divergence
    const divergenceIndex = approxState.messageHashes.findIndex(
      (h, i) => h !== currentHashes[i],
    );

    logger.info(
      `[NearMissTelemetry] Strict prefix match failed, but strong approximate match found. ` +
        `This suggests VS Code modified history (mutation) rather than branching. ` +
        `Key=${approxKey} ` +
        `Overlap=${matchCount}/${approxState.messageHashes.length} (${(overlapRatio * 100).toFixed(1)}%) ` +
        `DivergenceIndex=${divergenceIndex} ` +
        `SystemPromptMatch=${approxState.messageHashes[0] === currentHashes[0]} ` +
        `ApproxID=${approxState.conversationId}`,
    );
  }

  /**
   * Find a prior conversation state that is an exact prefix of the current
   * message sequence. Used for conversationId inheritance - we only inherit
   * a conversationId from a prior state if ALL of its messages appear at the
   * START of the current messages (strict prefix relationship).
   *
   * This prevents conversationId collision when two conversations share some
   * messages but are actually different (e.g., ["hello", "A"] vs ["hello", "B"]).
   *
   * Returns the state with the longest matching prefix for best accuracy.
   */
  private findPrefixConversation(
    currentNormalizedHashes: string[],
    modelFamily: string,
  ): KnownConversationState | undefined {
    let bestState: KnownConversationState | undefined;
    let bestLength = 0;

    for (const [key, state] of this.knownStates) {
      // Must be same model family
      if (!key.startsWith(modelFamily + ":")) continue;

      // Must be shorter than or equal to current (can't be a prefix if longer)
      if (state.messageHashes.length > currentNormalizedHashes.length) continue;

      // Check if all hashes in state match the corresponding prefix of current
      let isPrefix = true;
      for (let i = 0; i < state.messageHashes.length; i++) {
        if (state.messageHashes[i] !== currentNormalizedHashes[i]) {
          isPrefix = false;
          break;
        }
      }

      if (isPrefix && state.messageHashes.length > bestLength) {
        bestState = state;
        bestLength = state.messageHashes.length;
      }
    }

    return bestState;
  }

  /**
   * Identifies the best candidate conversation using the inverted index.
   * Uses set intersection over message hashes to select the best match.
   * Filters by model family to avoid cross-family contamination.
   * Returns the Key and State, or undefined.
   */
  private identifyConversation(
    currentNormalizedHashes: string[],
    modelFamily?: string,
  ): { key: string; state: KnownConversationState } | undefined {
    // logger.info(
    //   `[ConversationStateDebug] Identifying conversation: ${currentNormalizedHashes.length} hashes`,
    // );
    const frequencyMap = new Map<string, number>();
    let maxCount = 0;

    // Count occurrences for each conversation ID from the message hashes
    for (const hash of currentNormalizedHashes) {
      const ids = this.messageIndex.get(hash);
      if (ids) {
        // logger.info(
        //   `[ConversationStateDebug] Hit for hash ${hash.substring(0, 8)}: ${ids.size} candidates`,
        // );
        for (const id of ids) {
          const newCount = (frequencyMap.get(id) || 0) + 1;
          frequencyMap.set(id, newCount);
          if (newCount > maxCount) {
            maxCount = newCount;
          }
        }
      } else {
        // logger.info(
        //   `[ConversationStateDebug] Miss for hash ${hash.substring(0, 8)}`,
        // );
      }
    }

    logger.info(
      `[ConversationStateDebug] Identify result: maxCount=${maxCount} inputHashes=${currentNormalizedHashes.length}`,
    );

    if (maxCount === 0) return undefined;

    // Find the best match using overlap ratio (matches / known_hashes).
    // Prefer candidates that are proper subsets of the current conversation
    // (ratio = 1.0) over partial matches. If tied on ratio, prefer the one
    // with more absolute matches (larger known base = better anchor).
    // If still tied, prefer the most recent one.
    let bestKey: string | undefined;
    let bestRatio = 0;
    let bestCount = 0;

    for (let i = this.accessOrder.length - 1; i >= 0; i--) {
      const key = this.accessOrder[i];
      if (key === undefined) continue;
      const count = frequencyMap.get(key) ?? 0;
      if (count === 0) continue;

      // Filter by model family if specified (keys are formatted as "family:length:hash")
      if (modelFamily && !key.startsWith(modelFamily + ":")) continue;

      const state = this.knownStates.get(key);
      if (!state) continue;

      const ratio = count / state.messageHashes.length;

      // Prefer higher ratio first, then higher absolute count, then more recent
      if (ratio > bestRatio || (ratio === bestRatio && count > bestCount)) {
        bestKey = key;
        bestRatio = ratio;
        bestCount = count;
      }
    }

    if (bestKey) {
      return { key: bestKey, state: this.knownStates.get(bestKey)! };
    }

    return undefined;
  }

  /**
   * Get the known state for a model family.
   */
  getState(modelFamily: string): KnownConversationState | undefined {
    // Return the most recent state for this family
    for (let i = this.accessOrder.length - 1; i >= 0; i--) {
      const key = this.accessOrder[i];
      if (key && key.startsWith(modelFamily + ":")) {
        return this.knownStates.get(key);
      }
    }
    return undefined;
  }

  /**
   * Clear all known states (including persisted storage).
   */
  clear(): void {
    this.knownStates.clear();
    this.messageIndex.clear();
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
      const state = this.knownStates.get(oldest);
      if (state) {
        this.removeFromIndex(oldest, state);
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
        this.removeFromIndex(key, state);
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
          // Backfill conversationId for entries that lack one (migration)
          const state = entry.state.conversationId
            ? entry.state
            : { ...entry.state, conversationId: randomUUID() };
          this.knownStates.set(entry.key, state);
          // Rebuild index
          this.addToIndex(entry.key, state);
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
