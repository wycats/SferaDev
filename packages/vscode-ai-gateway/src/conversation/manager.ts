import * as vscode from "vscode";
import type {
  AgentEntry,
  AgentRegistry,
  AgentRegistryEvent,
  ContextManagementEdit,
} from "../agent/index.js";
import type {
  ActivityLogEntry,
  AIResponseEntry,
  CompactionEntry,
  Conversation,
  ErrorEntry,
  Subagent,
  UserMessageEntry,
} from "@vercel/conversation";
import type { TurnEntry } from "./types.js";
import { getTreeChangeLogger } from "../diagnostics/tree-change-log.js";
import { logger } from "../logger.js";
import type { TreeSnapshotTrigger } from "../logger/investigation-events.js";
import type {
  PersistentStore,
  PersistenceManager,
} from "../persistence/types.js";
import type { PersistedConversationMap } from "../persistence/stores.js";
import { CONVERSATION_TREE_STORE } from "../persistence/stores.js";

/** 5 minutes idle threshold per RFC 00073 */
const RECENT_ACTIVITY_WINDOW_MS = 5 * 60 * 1000;

interface CompactionTotals {
  /** Cumulative summarization tokens freed (from agent.summarizationReduction) */
  summarization: number;
  /** Our tracked cumulative context management tokens (since API is per-turn) */
  contextCumulative: number;
  /** Last seen context management total from current turn (to detect new edits) */
  lastContextTurnTotal: number;
}

/**
 * Builds conversation snapshots from status bar agent state.
 */
export class ConversationManager implements vscode.Disposable {
  private conversations = new Map<string, Conversation>();
  private previousCompactionState = new Map<string, CompactionTotals>();
  /** Track turn counts to detect new turns between rebuilds */
  private previousTurnCounts = new Map<string, number>();
  /** Track input tokens to compute actual delta when turn completes */
  private previousInputTokens = new Map<string, number>();
  /** Accumulated activity log entries per conversation (survives rebuilds) */
  private activityLogs = new Map<string, ActivityLogEntry[]>();
  private disposables: vscode.Disposable[] = [];
  /** Persistence store for conversation tree */
  private conversationStore: PersistentStore<PersistedConversationMap> | null =
    null;
  /** Conversations restored from persistence (shown as archived until active) */
  private restoredConversations = new Map<string, Conversation>();
  /** Track previous conversation statuses to detect idle/removed transitions */
  private previousStatuses = new Map<string, Conversation["status"]>();
  /** Callback for emitting tree.snapshot events on lifecycle transitions */
  private snapshotEmitter:
    | ((trigger: TreeSnapshotTrigger, conversations: Conversation[]) => void)
    | null = null;

  private readonly _onDidChangeConversations = new vscode.EventEmitter<
    string | undefined
  >();
  readonly onDidChangeConversations = this._onDidChangeConversations.event;

  constructor(private registry: AgentRegistry) {
    this.disposables.push(
      registry.onDidChangeAgents((event: AgentRegistryEvent) => {
        const chatId =
          "chatId" in event ? (event.chatId as string | undefined) : undefined;
        this.rebuild(chatId);
      }),
    );

    this.rebuild();
  }

  /**
   * Set a callback for emitting tree.snapshot events on lifecycle transitions
   * (conversation goes idle, conversation removed).
   */
  setSnapshotEmitter(
    emitter: (
      trigger: TreeSnapshotTrigger,
      conversations: Conversation[],
    ) => void,
  ): void {
    this.snapshotEmitter = emitter;
  }

  /**
   * Initialize persistence for conversation tree.
   * Call this after extension activation with the persistence manager.
   */
  initializePersistence(persistenceManager: PersistenceManager): void {
    this.conversationStore = persistenceManager.getStore(
      CONVERSATION_TREE_STORE,
    );
    this.restoreFromPersistence();
    // Trigger a rebuild to merge restored conversations into the tree
    this.rebuild();
  }

  /**
   * Restore conversations from persistence.
   */
  private restoreFromPersistence(): void {
    if (!this.conversationStore) return;

    const persisted = this.conversationStore.get();
    const now = Date.now();
    const maxAge = CONVERSATION_TREE_STORE.ttlMs ?? 24 * 60 * 60 * 1000;

    for (const [id, conv] of Object.entries(persisted.conversations)) {
      // Skip conversations older than TTL
      if (now - conv.lastActiveTime > maxAge) continue;

      // Restore activity log to our tracking map
      // Note: We don't restore previousTurnCounts here because detectActivityLogChanges
      // derives the baseline from the activity log itself (maxSeq), not from a tracked value.
      this.activityLogs.set(id, conv.activityLog as ActivityLogEntry[]);

      // Create a restored conversation (marked as archived)
      const restored: Conversation = {
        id: conv.id,
        title: conv.title,
        ...(conv.firstMessagePreview
          ? { firstMessagePreview: conv.firstMessagePreview }
          : {}),
        modelId: conv.modelId,
        status: "idle", // Restored conversations start as idle (shown at root)
        startTime: conv.startTime,
        lastActiveTime: conv.lastActiveTime,
        tokens: conv.tokens,
        turnCount: conv.turnCount,
        totalOutputTokens: conv.totalOutputTokens,
        compactionEvents: [], // Not persisted, will be rebuilt if agent becomes active
        activityLog: conv.activityLog as ActivityLogEntry[],
        subagents: conv.subagents as Subagent[],
        ...(conv.workspaceFolder
          ? { workspaceFolder: conv.workspaceFolder }
          : {}),
      };

      this.restoredConversations.set(id, restored);
    }
  }

  /**
   * Persist current conversation state.
   */
  private persistConversations(): void {
    if (!this.conversationStore) return;

    const conversations: Record<
      string,
      PersistedConversationMap["conversations"][string]
    > = {};

    for (const [id, conv] of this.conversations) {
      conversations[id] = {
        id: conv.id,
        title: conv.title,
        ...(conv.firstMessagePreview
          ? { firstMessagePreview: conv.firstMessagePreview }
          : {}),
        modelId: conv.modelId,
        status: conv.status,
        startTime: conv.startTime,
        lastActiveTime: conv.lastActiveTime,
        tokens: conv.tokens,
        turnCount: conv.turnCount,
        totalOutputTokens: conv.totalOutputTokens,
        activityLog: conv.activityLog,
        subagents: conv.subagents,
        ...(conv.workspaceFolder
          ? { workspaceFolder: conv.workspaceFolder }
          : {}),
      };
    }

    void this.conversationStore.set({ conversations });
  }

  /**
   * Dispose subscriptions and event emitters.
   */
  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
    this._onDidChangeConversations.dispose();
  }

  /**
   * Return the current conversation snapshots.
   */
  getConversations(): Conversation[] {
    return Array.from(this.conversations.values());
  }

  /**
   * Get the persisted turn count for a conversation.
   * This is derived from the activity log's max sequence number,
   * which is the single source of truth for turn counts.
   */
  getPersistedTurnCount(conversationId: string): number {
    // First check in-memory activity log
    const log = this.activityLogs.get(conversationId);
    if (log && log.length > 0) {
      return this.computeMaxSequence(log);
    }

    // Fall back to restored conversation
    const restored = this.restoredConversations.get(conversationId);
    if (restored?.activityLog && restored.activityLog.length > 0) {
      return this.computeMaxSequence(restored.activityLog);
    }

    // Fall back to persisted store
    if (this.conversationStore) {
      const persisted = this.conversationStore.get();
      const conv = persisted.conversations[conversationId];
      if (conv?.activityLog && conv.activityLog.length > 0) {
        return this.computeMaxSequence(conv.activityLog as ActivityLogEntry[]);
      }
    }

    return 0;
  }

  /**
   * Handle a conversation fork by truncating the activity log and emitting a fork event.
   */
  handleFork(
    conversationId: string,
    forkPoint: number,
    previousMessageCount: number,
    newMessageCount: number,
    causedByChatId?: string,
  ): void {
    const log = this.activityLogs.get(conversationId) ?? [];
    const forkSequence = Math.floor(forkPoint / 2);
    const originalLength = log.length;

    const truncated = log.filter((entry) => {
      if (entry.type === "user-message" || entry.type === "ai-response") {
        return entry.sequenceNumber <= forkSequence;
      }
      if (entry.type === "compaction") {
        return entry.turnNumber <= forkSequence;
      }
      if (entry.type === "error") {
        return (
          entry.turnNumber === undefined || entry.turnNumber <= forkSequence
        );
      }
      return true;
    });

    this.activityLogs.set(conversationId, truncated);

    logger.info(
      `[ForkDetection] Reset activity log for ${conversationId.slice(0, 8)}: ` +
        `${originalLength} → ${truncated.length} entries (fork at sequence ${forkSequence})`,
    );

    getTreeChangeLogger().emitSingleOp(
      {
        type: "conversation-forked",
        conversationId,
        forkedFrom: conversationId,
        atSequence: forkSequence,
        previousMessageCount,
        newMessageCount,
      },
      conversationId,
      causedByChatId,
    );

    this._onDidChangeConversations.fire(causedByChatId);
  }

  /**
   * Compute the max sequence number from an activity log.
   */
  private computeMaxSequence(log: ActivityLogEntry[]): number {
    return log.reduce((max, entry) => {
      if (entry.type === "user-message" || entry.type === "ai-response") {
        return Math.max(max, entry.sequenceNumber);
      }
      return max;
    }, 0);
  }

  private rebuild(causedByChatId?: string): void {
    const agents = this.registry.getAgents();

    const parentIdentifiers = new Set<string>();
    for (const agent of agents) {
      if (agent.conversationId) {
        parentIdentifiers.add(agent.conversationId);
      }
      if (agent.agentTypeHash) {
        parentIdentifiers.add(agent.agentTypeHash);
      }
    }

    const rootAgents = agents.filter(
      (agent) =>
        !agent.parentConversationHash ||
        !parentIdentifiers.has(agent.parentConversationHash),
    );

    const nextConversations = new Map<string, Conversation>();

    for (const root of rootAgents) {
      const conversationId = this.getConversationId(root);
      const previous = this.conversations.get(conversationId);

      const conversation: Conversation = {
        id: conversationId,
        title: this.getAgentTitle(root),
        ...(root.firstUserMessagePreview != null
          ? { firstMessagePreview: root.firstUserMessagePreview }
          : {}),
        modelId: root.modelId ?? "unknown",
        status: this.mapConversationStatus(root),
        startTime: root.startTime,
        lastActiveTime: root.lastUpdateTime,
        tokens: {
          input: this.getInputTokens(root),
          output: root.outputTokens,
          maxInput: root.maxInputTokens ?? 0,
        },
        turnCount: root.turnCount,
        totalOutputTokens: root.totalOutputTokens,
        compactionEvents: previous?.compactionEvents
          ? [...previous.compactionEvents]
          : [],
        activityLog: [],
        subagents: [],
        ...this.getWorkspaceFolderProp(),
      };

      conversation.subagents = this.buildSubagentHierarchy(
        root,
        agents,
        new Set([conversationId]),
      );

      this.detectCompactionEvents(root, conversation);
      this.detectActivityLogChanges(root, conversation);

      // Assign the accumulated activity log
      conversation.activityLog = this.activityLogs.get(conversationId) ?? [];

      nextConversations.set(conversationId, conversation);
    }

    // Merge in restored conversations that aren't currently active
    for (const [id, restored] of this.restoredConversations) {
      if (!nextConversations.has(id)) {
        nextConversations.set(id, restored);
      } else {
        // Active conversation supersedes restored one
        this.restoredConversations.delete(id);
      }
    }

    this.conversations = nextConversations;
    this.pruneCompactionState();

    // Detect lifecycle transitions and emit tree.snapshot events
    if (this.snapshotEmitter) {
      const allConversations = Array.from(nextConversations.values());

      // Check for conversations that transitioned to idle
      for (const [id, conv] of nextConversations) {
        const prevStatus = this.previousStatuses.get(id);
        if (prevStatus === "active" && conv.status === "idle") {
          this.snapshotEmitter("idle", allConversations);
          break; // One snapshot per rebuild is sufficient
        }
      }

      // Check for conversations that were removed (existed before, gone now)
      for (const id of this.previousStatuses.keys()) {
        if (!nextConversations.has(id)) {
          this.snapshotEmitter("removed", allConversations);
          break; // One snapshot per rebuild is sufficient
        }
      }
    }

    // Update previous statuses for next rebuild
    this.previousStatuses.clear();
    for (const [id, conv] of nextConversations) {
      this.previousStatuses.set(id, conv.status);
    }

    // Persist conversation state for cross-reload restoration
    this.persistConversations();

    // Log tree changes for debugging
    getTreeChangeLogger().logChanges(
      Array.from(nextConversations.values()),
      causedByChatId,
    );

    this._onDidChangeConversations.fire(causedByChatId);
  }

  private pruneCompactionState(): void {
    for (const conversationId of this.previousCompactionState.keys()) {
      if (!this.conversations.has(conversationId)) {
        this.previousCompactionState.delete(conversationId);
      }
    }
    for (const conversationId of this.previousTurnCounts.keys()) {
      if (!this.conversations.has(conversationId)) {
        this.previousTurnCounts.delete(conversationId);
        this.previousInputTokens.delete(conversationId);
        this.activityLogs.delete(conversationId);
      }
    }
  }

  private mapConversationStatus(agent: AgentEntry): Conversation["status"] {
    if (agent.status === "streaming") {
      return "active";
    }
    if (agent.status === "error") {
      return "idle";
    }

    const idleThreshold = Date.now() - RECENT_ACTIVITY_WINDOW_MS;
    return agent.lastUpdateTime >= idleThreshold ? "active" : "idle";
  }

  private getConversationId(agent: AgentEntry): string {
    return agent.conversationId ?? agent.id;
  }

  private getInputTokens(agent: AgentEntry): number {
    if (agent.lastActualInputTokens > 0) {
      return agent.lastActualInputTokens;
    }
    return agent.inputTokens;
  }

  private getAgentTitle(agent: AgentEntry): string {
    return agent.generatedTitle ?? agent.firstUserMessagePreview ?? agent.name;
  }

  private getWorkspaceFolderProp():
    | { workspaceFolder: string }
    | Record<string, never> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return folder != null ? { workspaceFolder: folder } : {};
  }

  private detectCompactionEvents(
    agent: AgentEntry,
    conversation: Conversation,
  ): void {
    const conversationId = conversation.id;
    const previous = this.previousCompactionState.get(conversationId) ?? {
      summarization: 0,
      contextCumulative: 0,
      lastContextTurnTotal: 0,
    };

    const currentSummarization = agent.summarizationReduction ?? 0;
    // Context management edits are per-turn (replaced each turn), not cumulative
    const currentTurnContextTotal =
      agent.contextManagement?.appliedEdits.reduce(
        (total, edit) => total + edit.clearedInputTokens,
        0,
      ) ?? 0;

    const now = Date.now();

    // Summarization reduction IS cumulative in the API
    if (currentSummarization > previous.summarization) {
      conversation.compactionEvents.push({
        timestamp: now,
        turnNumber: agent.turnCount,
        freedTokens: currentSummarization - previous.summarization,
        type: "summarization",
      });
    }

    // Context management: detect new edits by comparing current turn total
    // If the turn total changed, we have new edits this turn
    if (
      currentTurnContextTotal > 0 &&
      currentTurnContextTotal !== previous.lastContextTurnTotal
    ) {
      const details = this.formatContextDetails(
        agent.contextManagement?.appliedEdits,
      );
      conversation.compactionEvents.push({
        timestamp: now,
        turnNumber: agent.turnCount,
        freedTokens: currentTurnContextTotal,
        type: "context_management",
        ...(details ? { details } : {}),
      });
    }

    this.previousCompactionState.set(conversationId, {
      summarization: currentSummarization,
      contextCumulative:
        previous.contextCumulative +
        (currentTurnContextTotal !== previous.lastContextTurnTotal
          ? currentTurnContextTotal
          : 0),
      lastContextTurnTotal: currentTurnContextTotal,
    });
  }

  private formatContextDetails(
    edits: ContextManagementEdit[] | undefined,
  ): string | undefined {
    if (!edits || edits.length === 0) {
      return undefined;
    }
    return `edits:${edits.length}`;
  }

  /**
   * Detect turn changes and errors, appending entries to the activity log.
   */
  private detectActivityLogChanges(
    agent: AgentEntry,
    conversation: Conversation,
  ): void {
    const conversationId = conversation.id;
    const log = (this.activityLogs.get(conversationId) ?? []) as (
      | ActivityLogEntry
      | TurnEntry
    )[];
    const now = Date.now();

    // Use the max sequence from USER MESSAGES in the activity log as the
    // baseline. AI responses can exist ahead of user messages during
    // streaming (we create the AI response before the user message for the
    // current turn). Using user-message-only ensures previousTurnCount
    // reflects fully-processed turns, so the completion branch fires
    // correctly when turnCount increments.
    const maxSeq = log.reduce((max, e) => {
      if (e.type === "user-message") {
        return Math.max(max, e.sequenceNumber);
      }
      return max;
    }, 0);

    // If the agent's turnCount is behind the activity log, sync it up.
    // This can happen when the agent state store has a stale turnCount
    // but the activity log has more entries (e.g., after a reload).
    if (agent.turnCount < maxSeq && agent.conversationId) {
      this.registry.syncAgentTurnCount(agent.conversationId, maxSeq);
      // Update the local agent reference too
      agent.turnCount = maxSeq;
    }

    // Use maxSeq as the baseline for detecting new turns
    const previousTurnCount = maxSeq;

    logger.info(
      `[ConversationManager] detectActivityLogChanges`,
      JSON.stringify({
        conversationId: conversationId.slice(0, 8),
        agentTurnCount: agent.turnCount,
        previousTurnCount,
        agentStatus: agent.status,
        logLength: log.length,
        agentOutputTokens: agent.outputTokens,
      }),
    );

    const isLegacyTurnEntry = (
      entry: ActivityLogEntry | TurnEntry,
    ): entry is TurnEntry => entry.type === "turn";

    const ensureUserMessage = (
      sequenceNumber: number,
      timestamp: number,
      tokenContribution?: number,
    ): UserMessageEntry => {
      const existing = log.find(
        (entry): entry is UserMessageEntry =>
          entry.type === "user-message" &&
          entry.sequenceNumber === sequenceNumber,
      );

      if (existing) {
        // Update token contribution if provided and not already set
        if (
          tokenContribution !== undefined &&
          existing.tokenContribution === undefined
        ) {
          existing.tokenContribution = tokenContribution;
        }
        return existing;
      }

      const entry: UserMessageEntry = {
        type: "user-message",
        sequenceNumber,
        timestamp,
        ...(sequenceNumber === 1 && conversation.firstMessagePreview
          ? { preview: conversation.firstMessagePreview }
          : {}),
        ...(tokenContribution !== undefined ? { tokenContribution } : {}),
      };
      log.push(entry);
      return entry;
    };

    const ensureAIResponse = (
      sequenceNumber: number,
      timestamp: number,
      state: AIResponseEntry["state"],
      tokenContribution: number,
    ): AIResponseEntry => {
      const existing = log.find(
        (entry): entry is AIResponseEntry =>
          entry.type === "ai-response" &&
          entry.sequenceNumber === sequenceNumber,
      );

      if (existing) {
        existing.state = state;
        existing.tokenContribution = tokenContribution;
        return existing;
      }

      const entry: AIResponseEntry = {
        type: "ai-response",
        sequenceNumber,
        timestamp,
        state,
        tokenContribution,
        subagentIds: [],
      };
      log.push(entry);
      return entry;
    };

    // Detect new turns (turnCount increased)
    if (agent.turnCount > previousTurnCount) {
      // Determine the starting turn for entry creation.
      // Normally turnCount advances by 1 (or a small number for tool calls).
      // After a fork/reload/summarization, turnCount can jump by a large
      // amount (e.g., 3 → 82). In that case, we only create entries for
      // the latest turn — the intermediate turns are historical and we have
      // no data for them. Creating empty skeleton entries would clutter the
      // tree with bare "Message #N" nodes.
      const gap = agent.turnCount - previousTurnCount;
      const startTurn = gap > 1 ? agent.turnCount : previousTurnCount + 1;

      if (gap > 1) {
        logger.info(
          `[ConversationManager] Skipping ${gap - 1} historical turns (${previousTurnCount + 1}–${agent.turnCount - 1}) — no data available`,
        );
      }

      for (let turn = startTurn; turn <= agent.turnCount; turn++) {
        const isLatest = turn === agent.turnCount;
        const timestamp = isLatest
          ? now
          : now - (agent.turnCount - turn) * 1000;
        const isStreaming = isLatest && agent.status === "streaming";

        // Pass estimatedDeltaTokens for the latest turn's user message
        const tokenContribution = isLatest
          ? agent.estimatedDeltaTokens
          : undefined;
        ensureUserMessage(turn, timestamp, tokenContribution);

        const existingResponse = log.find(
          (entry): entry is AIResponseEntry =>
            entry.type === "ai-response" && entry.sequenceNumber === turn,
        );
        const responseState: AIResponseEntry["state"] = isStreaming
          ? "streaming"
          : existingResponse?.characterization
            ? "characterized"
            : "pending-characterization";

        ensureAIResponse(
          turn,
          timestamp,
          responseState,
          isLatest && !isStreaming ? agent.outputTokens : 0,
        );
      }
    } else if (agent.status === "streaming") {
      // Agent is streaming - create/update the AI response for the pending turn.
      // We intentionally do NOT create a user message here — the streaming
      // AI response nests under the most recent user message in the tree
      // builder (groupByUserMessage). When the turn completes and turnCount
      // increments, the completion branch creates the user message, and the
      // tree builder regroups the AI response under its proper parent.
      //
      // Exception: for the very first turn (turnCount === 0), there's no
      // previous user message to nest under, so we create one to avoid the
      // AI response being orphaned (orphans are dropped from the tree).
      const pendingSequenceNumber = agent.turnCount + 1;

      const existingPendingResponse = log.find(
        (entry): entry is AIResponseEntry =>
          entry.type === "ai-response" &&
          entry.sequenceNumber === pendingSequenceNumber,
      );

      if (existingPendingResponse) {
        existingPendingResponse.state = "streaming";
        // Update token contribution as we stream
        existingPendingResponse.tokenContribution = agent.outputTokens;
      } else {
        // First turn has no previous user message to nest under
        if (agent.turnCount === 0) {
          ensureUserMessage(
            pendingSequenceNumber,
            now,
            agent.estimatedDeltaTokens,
          );
        }
        ensureAIResponse(
          pendingSequenceNumber,
          now,
          "streaming",
          agent.outputTokens,
        );
      }
    } else {
      // Not streaming anymore — finalize any streaming turns
      // This handles both normal completion and stale streaming state from persistence
      for (const entry of log) {
        if (entry.type === "ai-response" && entry.state === "streaming") {
          if (entry.sequenceNumber <= agent.turnCount) {
            entry.state = entry.characterization
              ? "characterized"
              : "pending-characterization";
            if (entry.sequenceNumber === agent.turnCount) {
              entry.tokenContribution = agent.outputTokens;

              // Update user message with actual token delta (replaces estimate)
              const prevInputTokens =
                this.previousInputTokens.get(conversationId) ?? 0;
              const actualInputTokens = agent.lastActualInputTokens;
              if (actualInputTokens > 0 && prevInputTokens > 0) {
                const actualDelta = actualInputTokens - prevInputTokens;
                const userMessage = log.find(
                  (e): e is UserMessageEntry =>
                    e.type === "user-message" &&
                    e.sequenceNumber === entry.sequenceNumber,
                );
                if (userMessage && actualDelta > 0) {
                  userMessage.tokenContribution = actualDelta;
                }
              }
            }
          } else {
            entry.state = "interrupted";
          }
        }

        if (isLegacyTurnEntry(entry) && entry.streaming) {
          entry.streaming = false;
          if (entry.turnNumber === agent.turnCount) {
            entry.outputTokens = agent.outputTokens;
          }
        }
      }
    }

    // Detect error status
    if (agent.status === "error") {
      // Only add error entry once (don't duplicate on subsequent rebuilds)
      const hasRecentError = log.some(
        (e): e is ErrorEntry =>
          e.type === "error" &&
          (e.turnNumber === agent.turnCount || e.turnNumber === undefined),
      );
      if (!hasRecentError) {
        const errorEntry: ErrorEntry = {
          type: "error",
          timestamp: now,
          ...(agent.turnCount > 0 ? { turnNumber: agent.turnCount } : {}),
          message: "Request failed",
        };
        log.push(errorEntry);
      }
    }

    // Sync compaction events into activity log
    // New compaction events are those beyond what we already have in the log
    const existingCompactionCount = log.filter(
      (e) => e.type === "compaction",
    ).length;
    const allCompactionEvents = conversation.compactionEvents;
    for (let i = existingCompactionCount; i < allCompactionEvents.length; i++) {
      const event = allCompactionEvents[i];
      if (event) {
        const entry: CompactionEntry = {
          type: "compaction",
          timestamp: event.timestamp,
          turnNumber: event.turnNumber,
          freedTokens: event.freedTokens,
          compactionType: event.type,
          ...(event.details != null ? { details: event.details } : {}),
        };
        log.push(entry);
      }
    }

    this.previousTurnCounts.set(conversationId, agent.turnCount);
    // Track input tokens for computing actual delta on next turn completion
    if (agent.lastActualInputTokens > 0) {
      this.previousInputTokens.set(conversationId, agent.lastActualInputTokens);
    }
    this.activityLogs.set(conversationId, log as ActivityLogEntry[]);
  }

  /**
   * Update a turn's characterization label.
   * Called asynchronously after turn characterization completes.
   */
  updateTurnCharacterization(
    conversationId: string,
    turnNumber: number,
    characterization: string,
  ): void {
    const log = (this.activityLogs.get(conversationId) ?? []) as (
      | ActivityLogEntry
      | TurnEntry
    )[];

    const response = log.find(
      (entry): entry is AIResponseEntry =>
        entry.type === "ai-response" && entry.sequenceNumber === turnNumber,
    );
    if (response) {
      response.characterization = characterization;
      response.state = "characterized";
      this._onDidChangeConversations.fire(undefined);
      return;
    }

    const legacyTurn = log.find(
      (entry): entry is TurnEntry =>
        entry.type === "turn" && entry.turnNumber === turnNumber,
    );

    if (legacyTurn) {
      legacyTurn.characterization = characterization;
      this._onDidChangeConversations.fire(undefined);
    }
  }

  /**
   * Mark a turn as a tool continuation (triggered by tool results, not user message).
   * Called when the provider detects tool result parts in the request.
   */
  markToolContinuation(conversationId: string, turnNumber: number): void {
    const log = this.activityLogs.get(conversationId);
    if (!log) {
      return;
    }

    const userMessage = log.find(
      (entry): entry is UserMessageEntry =>
        entry.type === "user-message" && entry.sequenceNumber === turnNumber,
    );

    if (userMessage) {
      userMessage.isToolContinuation = true;
      this._onDidChangeConversations.fire(undefined);
    }
  }

  /**
   * Set the preview text for a user message entry.
   * Called after turn completion with the extracted user message text.
   */
  setUserMessagePreview(
    conversationId: string,
    turnNumber: number,
    preview: string,
  ): void {
    const log = this.activityLogs.get(conversationId);
    if (!log) {
      return;
    }

    const userMessage = log.find(
      (entry): entry is UserMessageEntry =>
        entry.type === "user-message" && entry.sequenceNumber === turnNumber,
    );

    if (userMessage && !userMessage.preview) {
      userMessage.preview = preview;
      getTreeChangeLogger().logChanges(Array.from(this.conversations.values()));
      this._onDidChangeConversations.fire(undefined);
    }
  }

  /**
   * Set full tool call details for an AI response entry.
   * Called after turn completion with the list of tool calls made.
   * Also derives toolsUsed (names only) for backward compatibility.
   */
  setToolCalls(
    conversationId: string,
    turnNumber: number,
    toolCalls: {
      callId: string;
      name: string;
      args: Record<string, unknown>;
    }[],
  ): void {
    const log = this.activityLogs.get(conversationId);
    if (!log) {
      return;
    }

    const response = log.find(
      (entry): entry is AIResponseEntry =>
        entry.type === "ai-response" && entry.sequenceNumber === turnNumber,
    );

    if (response) {
      response.toolCalls = toolCalls;
      // Derive toolsUsed for backward compatibility
      const names = [...new Set(toolCalls.map((tc) => tc.name))];
      response.toolsUsed = names;
      getTreeChangeLogger().logChanges(Array.from(this.conversations.values()));
      this._onDidChangeConversations.fire(undefined);
    }
  }

  /**
   * Set the tools used for an AI response entry (names only).
   * Fallback for when full tool call details are not available.
   */
  setToolsUsed(
    conversationId: string,
    turnNumber: number,
    toolsUsed: string[],
  ): void {
    const log = this.activityLogs.get(conversationId);
    if (!log) {
      return;
    }

    const response = log.find(
      (entry): entry is AIResponseEntry =>
        entry.type === "ai-response" && entry.sequenceNumber === turnNumber,
    );

    if (response) {
      response.toolsUsed = toolsUsed;
      getTreeChangeLogger().logChanges(Array.from(this.conversations.values()));
      this._onDidChangeConversations.fire(undefined);
    }
  }

  private buildSubagentHierarchy(
    parent: AgentEntry,
    allAgents: AgentEntry[],
    seen: Set<string>,
  ): Subagent[] {
    const parentIdentifiers = [
      parent.conversationId,
      parent.agentTypeHash,
    ].filter((value): value is string => Boolean(value));

    if (parentIdentifiers.length === 0) {
      return [];
    }

    const children = allAgents.filter(
      (agent) =>
        agent.parentConversationHash !== undefined &&
        agent.parentConversationHash !== null &&
        parentIdentifiers.includes(agent.parentConversationHash),
    );

    const subagents: Subagent[] = [];

    for (const child of children) {
      const childId = this.getConversationId(child);
      if (seen.has(childId)) {
        continue;
      }

      const nextSeen = new Set(seen);
      nextSeen.add(childId);

      subagents.push({
        conversationId: childId,
        name: this.getAgentTitle(child),
        tokens: {
          input: this.getInputTokens(child),
          output: child.outputTokens,
        },
        turnCount: child.turnCount,
        status: child.status,
        children: this.buildSubagentHierarchy(child, allAgents, nextSeen),
      });
    }

    return subagents;
  }
}
