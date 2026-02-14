import * as vscode from "vscode";
import {
  DiagnosticDump,
  treeDiagnostics,
  TreeDiagnostics,
} from "./diagnostics/tree-diagnostics.js";
import { ClaimRegistry } from "./identity/index.js";
import { logger } from "./logger";
import {
  createPersistenceManager,
  AGENT_STATE_STORE,
  SESSION_STATS_STORE,
  type PersistedAgentStateMap,
  type SessionStats,
} from "./persistence/index.js";
import type {
  PersistentStore,
  PersistenceManager,
} from "./persistence/index.js";
import { formatTokens, getDisplayTokens } from "./tokens/display.js";

/**
 * Context management edit from Anthropic's API
 */
export interface ContextManagementEdit {
  type: "clear_tool_uses_20250919" | "clear_thinking_20251015";
  clearedInputTokens: number;
  clearedToolUses?: number;
  clearedThinkingTurns?: number;
}

export interface ContextManagementInfo {
  appliedEdits: ContextManagementEdit[];
}

/**
 * Token usage data from a completed request
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  maxInputTokens?: number | undefined;
  modelId?: string | undefined;
  contextManagement?: ContextManagementInfo | undefined;
  /** Number of messages in this request (for delta estimation on next turn) */
  messageCount?: number | undefined;
}

/**
 * Agent entry tracking token usage for a single LM call
 */
export interface AgentEntry {
  id: string;
  /** Short display name (e.g., "recon", "execute", or hash) */
  name: string;
  startTime: number;
  lastUpdateTime: number;
  /** Input tokens from the most recent turn */
  inputTokens: number;
  /** Output tokens from the most recent turn */
  outputTokens: number;
  /** Most recent actual input tokens (updated each turn, reflects post-summarization reductions) */
  lastActualInputTokens: number;
  /** Cumulative output tokens across all turns in this conversation */
  totalOutputTokens: number;
  /** Number of turns (request/response cycles) in this conversation */
  turnCount: number;
  /** Number of messages in the last completed request (for delta estimation) */
  lastMessageCount?: number | undefined;
  maxInputTokens?: number | undefined;
  estimatedInputTokens?: number | undefined;
  /** Estimated tokens for NEW messages only (delta from previous state) */
  estimatedDeltaTokens?: number | undefined;
  modelId?: string | undefined;
  status: "streaming" | "complete" | "error";
  contextManagement?: ContextManagementInfo | undefined;
  /** Whether this agent has been dimmed due to inactivity */
  dimmed: boolean;
  /** Is this the main/primary agent (first in conversation)? */
  isMain: boolean;
  /** Order in which this agent completed (for aging) */
  completionOrder?: number | undefined;
  /** Hash of system prompt - diagnostics only */
  systemPromptHash?: string | undefined;
  // Identity tracking (RFC 00033)
  /** Computed once at conversation start from toolSetHash */
  agentTypeHash?: string | undefined;
  /** Parent's conversation identifier if this is a subagent */
  parentConversationHash?: string | null | undefined;
  /** Conversation hashes of child agents spawned by this agent */
  childConversationHashes?: string[] | undefined;
  /** Hash of first user message (computed at conversation start) */
  firstUserMessageHash?: string | undefined;

  /** Source of the token estimate (for diagnostics/UI) */
  estimationSource?: "exact" | "delta" | "estimated" | undefined;
  /** Stable conversation UUID from stateful marker sessionId (primary identity) */
  conversationId?: string | undefined;
  /** Whether VS Code summarization was detected (token drop ≥30%) */
  summarizationDetected?: boolean | undefined;
  /** Tokens freed by summarization (previous - current input tokens) */
  summarizationReduction?: number | undefined;
  /** Whether this request is a summarization request (detected from message content) */
  isSummarization?: boolean | undefined;
  /** Turns remaining before the ↓ suffix fades (set to 2 on summarization detection) */
  summarizationFadeTurns?: number | undefined;
}

/** Agent aging configuration */
const AGENT_DIM_AFTER_REQUESTS = 2; // Dim after 2 newer agents complete
const AGENT_REMOVE_AFTER_REQUESTS = 5; // Remove after 5 newer agents complete
const AGENT_CLEANUP_INTERVAL_MS = 2_000; // Check for stale agents every 2 seconds

/**
 * Token estimation state for status bar display.
 * Shows whether we have known actual token counts or are estimating.
 */
export interface EstimationState {
  /** Model family identifier */
  modelFamily: string;
  /** Known actual tokens from last API response */
  knownTokens: number;
  /** Number of messages with known token counts */
  knownMessageCount: number;
  /** Whether this is the most recent conversation state */
  isCurrent: boolean;
}

/**
 * Status bar item that displays token usage information with agent tracking.
 *
 * Shows:
 * - Main agent: "$(debug-breakpoint-function) 52k/128k"
 * - While streaming: "$(loading~spin) ..."
 * - While summarizing: "$(sync~spin) summarizing..."
 * - After compaction: "52k/128k ↓15k" (suffix fades after 2 turns)
 *
 * Agents are tracked and aged based on subsequent requests:
 * - Active agents show full visibility
 * - Agents dim after 2 newer agents complete
 * - Agents are removed after 5 newer agents complete
 */
export class TokenStatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private currentUsage: TokenUsage | null = null;
  private hideTimeout: ReturnType<typeof setTimeout> | null = null;

  // Agent tracking
  private agents = new Map<string, AgentEntry>();
  private mainAgentId: string | null = null;
  private activeAgentId: string | null = null;
  /** The conversationId of the most recently active agent (survives idle transitions) */
  private lastActiveConversationId: string | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private completedAgentCount = 0;
  /** Peak input tokens observed across all agents in this session (for session stats) */
  private sessionPeakInputTokens = 0;

  // Estimation state tracking
  private estimationStates = new Map<string, EstimationState>();

  private persistenceManager: PersistenceManager | null = null;
  private sessionStatsStore: PersistentStore<SessionStats> | null = null;
  private agentStateStore: PersistentStore<PersistedAgentStateMap> | null =
    null;

  // Event emitter for agent tree updates
  private readonly _onDidChangeAgents = new vscode.EventEmitter<void>();
  // Claim registry for parent-child linking (RFC 00033)
  private claimRegistry = new ClaimRegistry();
  // Stable conversation identity lookup (stateful marker sessionId)
  private agentsByConversationId = new Map<string, AgentEntry>();
  // Map request IDs to canonical agent IDs (for deduped conversations)
  private agentIdAliases = new Map<string, string>();
  /** Fired when agents are added, updated, or removed */
  readonly onDidChangeAgents = this._onDidChangeAgents.event;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.statusBarItem.name = "Vercel AI Token Usage";
    this.statusBarItem.command = "vercel.ai.agentTree.focus";
    this.hide();

    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleAgents();
    }, AGENT_CLEANUP_INTERVAL_MS);
  }

  /**
   * Initialize persistence for session stats.
   * Call this after extension activation with the extension context.
   */
  initializePersistence(context: vscode.ExtensionContext): void {
    this.persistenceManager = createPersistenceManager(context);
    this.sessionStatsStore =
      this.persistenceManager.getStore(SESSION_STATS_STORE);
    this.agentStateStore = this.persistenceManager.getStore(AGENT_STATE_STORE);
  }

  /**
   * Get last session stats for display on boot.
   */
  getLastSessionStats(): SessionStats | null {
    if (!this.sessionStatsStore) return null;
    const stats = this.sessionStatsStore.get();
    // Return null if no meaningful data (timestamp 0 means never saved)
    if (stats.timestamp === 0) return null;
    return stats;
  }

  /**
   * Update estimation state for a model.
   * Called after each API response to track known token state.
   */
  setEstimationState(state: EstimationState): void {
    this.estimationStates.set(state.modelFamily, state);
    logger.debug(
      `[StatusBar] Estimation state updated for ${state.modelFamily}`,
      JSON.stringify({
        knownTokens: state.knownTokens,
        knownMessageCount: state.knownMessageCount,
        isCurrent: state.isCurrent,
      }),
    );
    // Trigger display update to refresh tooltip
    this.updateDisplay();
  }

  /**
   * Get estimation state for a model.
   */
  getEstimationState(modelFamily: string): EstimationState | undefined {
    return this.estimationStates.get(modelFamily);
  }

  /**
   * Get all estimation states.
   */
  getAllEstimationStates(): EstimationState[] {
    return Array.from(this.estimationStates.values());
  }

  /**
   * Get the previous turn's context for a conversation.
   * Used by the provider to compute delta token estimates for resumed agents.
   * Returns undefined if the conversation has no completed turns.
   */
  getAgentContext(
    conversationId: string,
  ): { lastActualInputTokens: number; lastMessageCount: number } | undefined {
    // First check in-memory agents (current session)
    const agent = this.agentsByConversationId.get(conversationId);
    if (agent && agent.lastActualInputTokens > 0 && agent.lastMessageCount) {
      return {
        lastActualInputTokens: agent.lastActualInputTokens,
        lastMessageCount: agent.lastMessageCount,
      };
    }

    // Fallback to persisted state (cross-reload)
    if (this.agentStateStore) {
      const persisted = this.agentStateStore.get().entries[conversationId];
      if (
        persisted &&
        persisted.lastActualInputTokens > 0 &&
        persisted.lastMessageCount > 0
      ) {
        return {
          lastActualInputTokens: persisted.lastActualInputTokens,
          lastMessageCount: persisted.lastMessageCount,
        };
      }
    }

    return undefined;
  }

  private saveAgentState(agent: AgentEntry): void {
    if (!this.agentStateStore || !agent.conversationId) return;
    const conversationId = agent.conversationId;
    void this.agentStateStore.update((current) => ({
      entries: {
        ...current.entries,
        [conversationId]: {
          lastActualInputTokens: agent.lastActualInputTokens,
          lastMessageCount: agent.lastMessageCount ?? 0,
          turnCount: agent.turnCount,
          ...(agent.modelId != null ? { modelId: agent.modelId } : {}),
          ...(agent.summarizationDetected && agent.summarizationReduction
            ? {
                summarizationDetected: true,
                summarizationReduction: agent.summarizationReduction,
              }
            : {}),
          fetchedAt: Date.now(),
        },
      },
    }));
  }

  /**
   * Create a tree snapshot for diagnostics.
   */
  private createTreeSnapshot() {
    return TreeDiagnostics.createSnapshot(
      this.agents,
      this.claimRegistry.getClaims(),
      this.mainAgentId,
      this.activeAgentId,
    );
  }

  /**
   * Extract a short name from agent context
   */
  private extractAgentName(
    agentId: string,
    modelId?: string,
    isMain?: boolean,
  ): string {
    // For subagents, use a generic "sub" name
    // (In Phase 3, we'll extract from system prompt)
    if (isMain === false) {
      return "sub";
    }

    // For main agent, try to extract from model ID
    // (e.g., "anthropic:claude-sonnet-4" -> "claude-sonnet-4")
    if (modelId) {
      // If it contains a colon, extract after it
      const colonIdx = modelId.indexOf(":");
      if (colonIdx >= 0) {
        return modelId.slice(colonIdx + 1);
      }
      // Otherwise use the full modelId
      return modelId;
    }
    // Fall back to last 6 chars of agentId
    return agentId.slice(-6);
  }

  private resolveAgentId(agentId: string): string {
    return this.agentIdAliases.get(agentId) ?? agentId;
  }

  private removeIdentityMappings(agent: AgentEntry): void {
    if (agent.conversationId) {
      const mapped = this.agentsByConversationId.get(agent.conversationId);
      if (mapped?.id === agent.id) {
        this.agentsByConversationId.delete(agent.conversationId);
      }
    }
  }

  private removeAliasesForAgent(agentId: string): void {
    for (const [key, value] of this.agentIdAliases) {
      if (value === agentId) {
        this.agentIdAliases.delete(key);
      }
    }
  }

  /**
   * Create a child agent that matched a pending claim.
   * This is called when we detect a subagent that has a claim waiting for it.
   * Extracted to ensure claim-matched children are never merged into an existing agent.
   */
  private createChildAgent(
    agentId: string,
    now: number,
    estimatedTokens: number | undefined,
    maxTokens: number | undefined,
    modelId: string | undefined,
    systemPromptHash: string | undefined,
    agentTypeHash: string,
    firstUserMessageHash: string | undefined,
    claimMatch: { parentConversationHash: string; expectedChildName: string },
    estimatedDeltaTokens: number | undefined,
    estimationSource: "exact" | "delta" | "estimated" | undefined,
    conversationId: string | undefined,
    isSummarization: boolean | undefined,
  ): string {
    const agent: AgentEntry = {
      id: agentId,
      name: claimMatch.expectedChildName,
      startTime: now,
      lastUpdateTime: now,
      inputTokens: 0,
      outputTokens: 0,
      lastActualInputTokens: 0,
      totalOutputTokens: 0,
      turnCount: 0,
      maxInputTokens: maxTokens,
      estimatedInputTokens: estimatedTokens,
      estimatedDeltaTokens,
      estimationSource,
      modelId,
      status: "streaming",
      dimmed: false,
      isMain: false,
      systemPromptHash,
      agentTypeHash,
      firstUserMessageHash,
      parentConversationHash: claimMatch.parentConversationHash,
      conversationId,
      isSummarization: isSummarization ?? false,
    };

    this.agents.set(agentId, agent);
    this.agentIdAliases.set(agentId, agentId);
    // Register by conversationId for stable identity
    if (conversationId) {
      this.agentsByConversationId.set(conversationId, agent);
    }
    this.activeAgentId = agentId;
    this.trackActiveConversation(agent);

    logger.info(
      `[StatusBar] Child Agent STARTED (claim matched)`,
      JSON.stringify({
        timestamp: now,
        agentId: agentId.slice(-8),
        isMain: false,
        name: agent.name,
        systemPromptHash: systemPromptHash?.slice(0, 8),
        agentTypeHash: agentTypeHash.slice(0, 8),
        parentConversationHash: claimMatch.parentConversationHash.slice(0, 8),
        claimExpectedName: claimMatch.expectedChildName,
        totalAgents: this.agents.size,
      }),
    );

    // Tree diagnostics
    treeDiagnostics.log(
      "AGENT_STARTED",
      {
        agentId: agentId.slice(-8),
        isMain: false,
        name: agent.name,
        systemPromptHash: systemPromptHash?.slice(0, 8),
        agentTypeHash: agentTypeHash.slice(0, 8),
        parentConversationHash: claimMatch.parentConversationHash.slice(0, 8),
        claimMatched: true,
        claimExpectedName: claimMatch.expectedChildName,
        earlyClaimMatch: true, // Indicates this was matched before resume checks
      },
      this.createTreeSnapshot(),
      { vscodeSessionId: vscode.env.sessionId },
    );

    this.updateDisplay();
    this._onDidChangeAgents.fire();
    return agentId;
  }

  /**
   * Start tracking a new agent (LM call)
   * @param agentId Unique identifier for this agent
   * @param estimatedTokens Estimated input tokens
   * @param maxTokens Maximum input tokens for the model
   * @param modelId Model identifier
   * @param systemPromptHash Hash of the system prompt - diagnostics only
   * @param estimatedDeltaTokens Estimated tokens for NEW messages only (delta)
   * @param conversationId Stable conversation UUID from stateful_marker sessionId (GCMP pattern)
   */
  startAgent(
    agentId: string,
    estimatedTokens?: number,
    maxTokens?: number,
    modelId?: string,
    systemPromptHash?: string,
    agentTypeHash?: string,
    firstUserMessageHash?: string,
    estimatedDeltaTokens?: number,
    conversationId?: string,
    isSummarization?: boolean,
  ): string {
    const now = Date.now();

    const hasPendingClaims = this.claimRegistry.getPendingClaimCount() > 0;

    // Log subagent detection context for debugging
    const mainAgent = this.mainAgentId
      ? this.agents.get(this.mainAgentId)
      : null;
    const hasDifferentAgentType =
      mainAgent?.agentTypeHash !== undefined &&
      agentTypeHash !== undefined &&
      agentTypeHash !== mainAgent.agentTypeHash;

    // Check for conversation identity match (conversationId is a stable UUID)
    const existingByConversationId = conversationId
      ? this.agentsByConversationId.get(conversationId)
      : undefined;
    const existingAgent = existingByConversationId;

    logger.info(
      `[StatusBar] Subagent detection check`,
      JSON.stringify({
        agentId: agentId.slice(-8),
        hasDifferentAgentType,
        hasPendingClaims,
        mainAgentTypeHash: mainAgent?.agentTypeHash?.slice(0, 8),
        thisAgentTypeHash: agentTypeHash?.slice(0, 8),
        thisSystemPromptHash: systemPromptHash?.slice(0, 8),
        existingAgentMaxTokens: existingAgent?.lastActualInputTokens,
        thisEstimatedTokens: estimatedTokens,
        conversationId: conversationId?.slice(0, 8),
        matchedBy: existingByConversationId ? "conversationId" : "none",
      }),
    );

    // FIRST: Check claims only when there's no conversationId match.
    if (!existingAgent && hasPendingClaims && agentTypeHash) {
      const extractedName = this.extractAgentName(
        agentId,
        modelId,
        this.mainAgentId === null,
      );
      const claimMatch = this.matchChildClaim(extractedName, agentTypeHash);

      logger.info(
        `[StatusBar] Claim match attempt (pending claims exist)`,
        JSON.stringify({
          extractedName,
          agentTypeHash: agentTypeHash.slice(0, 8),
          claimMatched: claimMatch !== null,
          claimExpectedName: claimMatch?.expectedChildName,
        }),
      );

      if (claimMatch) {
        // This is a child agent - create it as new, don't resume
        return this.createChildAgent(
          agentId,
          now,
          estimatedTokens,
          maxTokens,
          modelId,
          systemPromptHash,
          agentTypeHash,
          firstUserMessageHash,
          claimMatch,
          estimatedDeltaTokens,
          undefined, // estimationSource not passed from provider
          conversationId,
          isSummarization,
        );
      }
    }

    // Resume any agent when conversationId matches.
    // NOTE: agentTypeHash is diagnostics only and can change between turns.
    if (existingAgent) {
      this.agentIdAliases.set(agentId, existingAgent.id);
      existingAgent.status = "streaming";
      existingAgent.lastUpdateTime = now;
      existingAgent.estimatedInputTokens = estimatedTokens;
      existingAgent.estimatedDeltaTokens = estimatedDeltaTokens;
      // Note: estimationSource is not passed from provider.ts, so we don't update it
      existingAgent.maxInputTokens =
        maxTokens ?? existingAgent.maxInputTokens ?? undefined;
      existingAgent.modelId = modelId ?? existingAgent.modelId;
      existingAgent.isSummarization = isSummarization ?? false;
      existingAgent.systemPromptHash =
        systemPromptHash ?? existingAgent.systemPromptHash;
      existingAgent.agentTypeHash =
        agentTypeHash ?? existingAgent.agentTypeHash;
      existingAgent.firstUserMessageHash =
        firstUserMessageHash ?? existingAgent.firstUserMessageHash;
      // Update conversationId if a new one is provided (may not have been available on first turn)
      if (conversationId && !existingAgent.conversationId) {
        existingAgent.conversationId = conversationId;
        this.agentsByConversationId.set(conversationId, existingAgent);
      }
      existingAgent.contextManagement = undefined;
      existingAgent.dimmed = false;
      existingAgent.completionOrder = undefined;

      if (existingAgent.isMain) {
        this.mainAgentId = existingAgent.id;
      }
      this.activeAgentId = existingAgent.id;
      this.trackActiveConversation(existingAgent);

      logger.info(
        `[StatusBar] Agent RESUMED (conversationId match)`,
        JSON.stringify({
          timestamp: now,
          agentId: agentId.slice(-8),
          canonicalAgentId: existingAgent.id.slice(-8),
          isMain: existingAgent.isMain,
          modelId: existingAgent.modelId,
          estimatedTokens,
          maxTokens,
          name: existingAgent.name,
          systemPromptHash: systemPromptHash?.slice(0, 8),
          agentTypeHash: existingAgent.agentTypeHash?.slice(0, 8),
          conversationId: existingAgent.conversationId?.slice(0, 8),
          totalAgents: this.agents.size,
          pendingClaimsPresent: hasPendingClaims,
        }),
      );

      treeDiagnostics.log(
        "AGENT_RESUMED",
        {
          agentId: agentId.slice(-8),
          canonicalAgentId: existingAgent.id.slice(-8),
          isMain: existingAgent.isMain,
          name: existingAgent.name,
          conversationId: existingAgent.conversationId?.slice(0, 8),
          systemPromptHash: systemPromptHash?.slice(0, 8),
          pendingClaimsPresent: hasPendingClaims,
        },
        this.createTreeSnapshot(),
        { vscodeSessionId: vscode.env.sessionId },
      );

      this.updateDisplay();
      this._onDidChangeAgents.fire();
      return existingAgent.id;
    }

    // Extract agent name from context first (needed for claim matching)
    // We need to do this before determining isMain because claim matching affects the decision
    const preliminaryIsMain = this.mainAgentId === null;
    const extractedAgentName = this.extractAgentName(
      agentId,
      modelId,
      preliminaryIsMain,
    );

    // CRITICAL: Don't do claim matching if this looks like the main agent.
    // This prevents the main agent's turns from being incorrectly attributed to
    // pending subagent claims when there's no conversationId match to identify a resume.
    //
    // We consider this "likely main" if there's no main agent yet.
    const likelyMainAgent = this.mainAgentId === null;

    // Try to match a pending claim to get parent linkage and expected name
    // Only do this if this doesn't look like the main agent.
    const claimMatch =
      !likelyMainAgent && agentTypeHash !== undefined
        ? this.matchChildClaim(extractedAgentName, agentTypeHash)
        : null;

    // Determine if this is the main agent or a subagent
    // Main agent: first agent OR no claim match
    // Subagent: has a claim match
    let isMain: boolean;
    if (this.mainAgentId === null) {
      // First agent is always main
      isMain = true;
      this.mainAgentId = agentId;
    } else if (claimMatch !== null) {
      // If there's a claim match, this is definitely a subagent
      // (parent agent called runSubagent and created a claim for this child)
      isMain = false;
    } else {
      // No claim match - treat as main agent
      if (this.mainAgentId !== null) {
        const previousMain = this.agents.get(this.mainAgentId);
        if (previousMain) {
          previousMain.isMain = false;
          logger.info(
            `[StatusBar] Demoted previous main agent`,
            JSON.stringify({
              timestamp: now,
              previousMainId: previousMain.id.slice(-8),
              newMainId: agentId.slice(-8),
            }),
          );
        }
      }
      isMain = true;
      this.mainAgentId = agentId;
    }
    const parentConversationHash = claimMatch?.parentConversationHash ?? null;
    // Determine the agent name:
    // 1. If there's a claim match, use the expected name from the claim (most authoritative)
    // 2. If this is the main agent, re-extract the name with the correct isMain value
    // 3. Otherwise, use the preliminary extracted name
    let agentName: string;
    if (claimMatch?.expectedChildName) {
      agentName = claimMatch.expectedChildName;
    } else if (isMain && !preliminaryIsMain) {
      // We determined this is main agent after preliminary check said it wasn't
      // Re-extract with correct isMain value to get the model name instead of "sub"
      agentName = this.extractAgentName(agentId, modelId, true);
    } else {
      agentName = extractedAgentName;
    }

    const agent: AgentEntry = {
      id: agentId,
      name: agentName,
      startTime: now,
      lastUpdateTime: now,
      inputTokens: 0,
      outputTokens: 0,
      lastActualInputTokens: 0,
      totalOutputTokens: 0,
      turnCount: 0,
      maxInputTokens: maxTokens,
      estimatedInputTokens: estimatedTokens,
      estimatedDeltaTokens,
      estimationSource: undefined, // Not passed from provider.ts
      modelId,
      status: "streaming",
      dimmed: false,
      isMain,
      systemPromptHash,
      agentTypeHash,
      firstUserMessageHash,
      parentConversationHash,
      conversationId,
      isSummarization: isSummarization ?? false,
    };

    this.agents.set(agentId, agent);
    this.agentIdAliases.set(agentId, agentId);
    // Register by conversationId for stable identity
    if (conversationId) {
      this.agentsByConversationId.set(conversationId, agent);
    }
    this.activeAgentId = agentId;
    this.trackActiveConversation(agent);

    logger.info(
      `[StatusBar] Agent STARTED`,
      JSON.stringify({
        timestamp: now,
        agentId: agentId.slice(-8),
        isMain,
        isSubagent: !isMain,
        modelId,
        estimatedTokens,
        maxTokens,
        name: agent.name,
        systemPromptHash: systemPromptHash?.slice(0, 8),
        agentTypeHash: agentTypeHash?.slice(0, 8),
        firstUserMessageHash: firstUserMessageHash?.slice(0, 8),
        parentConversationHash: parentConversationHash?.slice(0, 8),
        totalAgents: this.agents.size,
        claimMatched: claimMatch !== null,
      }),
    );

    // Tree diagnostics
    treeDiagnostics.log(
      "AGENT_STARTED",
      {
        agentId: agentId.slice(-8),
        isMain,
        name: agent.name,
        systemPromptHash: systemPromptHash?.slice(0, 8),
        agentTypeHash: agentTypeHash?.slice(0, 8),
        parentConversationHash: parentConversationHash?.slice(0, 8),
        claimMatched: claimMatch !== null,
        claimExpectedName: claimMatch?.expectedChildName,
      },
      this.createTreeSnapshot(),
      { vscodeSessionId: vscode.env.sessionId },
    );

    this.updateDisplay();
    this._onDidChangeAgents.fire();
    return agentId;
  }

  /**
   * Update agent activity timestamp during streaming.
   * Call this when receiving streaming data to keep lastUpdateTime fresh.
   */
  updateAgentActivity(agentId: string): void {
    const resolvedId = this.resolveAgentId(agentId);
    const agent = this.agents.get(resolvedId);
    if (agent?.status === "streaming") {
      agent.lastUpdateTime = Date.now();
      // Don't call updateDisplay here to avoid excessive updates
      // The display will refresh on the next scheduled update
    }
  }

  /**
   * Update agent with completed usage
   */
  completeAgent(agentId: string, usage: TokenUsage): void {
    const resolvedId = this.resolveAgentId(agentId);
    const agent = this.agents.get(resolvedId);
    if (!agent) {
      logger.warn(`Agent ${agentId} not found for completion`);
      return;
    }

    let justDetectedSummarization = false;

    // Store this turn's tokens
    agent.inputTokens = usage.inputTokens;
    agent.outputTokens = usage.outputTokens;

    // Detect VS Code summarization: a significant token drop between turns
    // indicates the conversation history was summarized/compacted.
    // Only check after the first turn (need a baseline to compare against).
    if (
      agent.turnCount > 0 &&
      agent.lastActualInputTokens > 0 &&
      usage.inputTokens < agent.lastActualInputTokens * 0.7
    ) {
      const reduction = agent.lastActualInputTokens - usage.inputTokens;
      agent.summarizationDetected = true;
      // Accumulate if multiple summarizations occur
      agent.summarizationReduction =
        (agent.summarizationReduction ?? 0) + reduction;
      agent.summarizationFadeTurns = 2;
      justDetectedSummarization = true;
      logger.info(
        `[StatusBar] Summarization detected`,
        JSON.stringify({
          agentId: agent.id,
          previousTokens: agent.lastActualInputTokens,
          currentTokens: usage.inputTokens,
          reduction,
          totalReduction: agent.summarizationReduction,
        }),
      );
    }

    // Fade the ↓ suffix over subsequent turns
    if (
      agent.summarizationFadeTurns !== undefined &&
      agent.summarizationFadeTurns > 0
    ) {
      // Don't decrement on the turn that SET it (summarization detection turn)
      // Only decrement on subsequent turns
      if (!justDetectedSummarization) {
        agent.summarizationFadeTurns--;
      }
    }

    agent.isSummarization = undefined;

    // Use latest actual input tokens (not historical peak).
    // After summarization, context shrinks — the display should reflect that.
    // Accumulate output (each turn generates new tokens)
    agent.lastActualInputTokens = usage.inputTokens;
    // Track session peak for session stats (this IS a max — survives summarization)
    this.sessionPeakInputTokens = Math.max(
      this.sessionPeakInputTokens,
      usage.inputTokens,
    );
    agent.totalOutputTokens += usage.outputTokens;
    agent.turnCount += 1;
    agent.maxInputTokens = usage.maxInputTokens ?? agent.maxInputTokens;
    agent.modelId = usage.modelId;
    agent.status = "complete";
    // Clear streaming estimate now that we have actual tokens (RFC 00040)
    agent.estimatedInputTokens = undefined;
    agent.lastUpdateTime = Date.now();
    agent.contextManagement = usage.contextManagement;
    agent.lastMessageCount = usage.messageCount;
    agent.completionOrder = this.completedAgentCount;

    this.completedAgentCount++;
    this.currentUsage = usage;

    // Save session stats
    this.saveSessionStats();
    this.saveAgentState(agent);

    // If this was the active agent, clear it
    if (this.activeAgentId === resolvedId) {
      this.activeAgentId = null;
    }

    this.agentIdAliases.delete(agentId);

    const contextEdits = usage.contextManagement?.appliedEdits ?? [];
    const freedTokens = contextEdits.reduce(
      (sum, e) => sum + e.clearedInputTokens,
      0,
    );

    logger.debug(
      `[StatusBar] Agent COMPLETED`,
      JSON.stringify({
        timestamp: agent.lastUpdateTime,
        agentId,
        canonicalAgentId: resolvedId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        maxInputTokens: usage.maxInputTokens,
        modelId: usage.modelId,
        completionOrder: agent.completionOrder,
        completedAgentCount: this.completedAgentCount,
        isMain: agent.isMain,
        wasActive: this.activeAgentId === null,
        totalAgents: this.agents.size,
        contextManagement:
          contextEdits.length > 0
            ? {
                editCount: contextEdits.length,
                freedTokens,
                edits: contextEdits.map((e) => ({
                  type: e.type,
                  clearedInputTokens: e.clearedInputTokens,
                })),
              }
            : null,
      }),
    );

    // Tree diagnostics
    treeDiagnostics.log(
      "AGENT_COMPLETED",
      {
        agentId: agentId.slice(-8),
        canonicalAgentId: resolvedId.slice(-8),
        isMain: agent.isMain,
        name: agent.name,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        turnCount: agent.turnCount,
        conversationId: agent.conversationId?.slice(0, 8),
      },
      this.createTreeSnapshot(),
      { vscodeSessionId: vscode.env.sessionId },
    );

    // Immediately age other agents based on new completion
    this.ageAgents();

    this.updateDisplay();
    this._onDidChangeAgents.fire();
    this.scheduleHide();
  }

  /**
   * Mark an agent as errored
   */
  errorAgent(agentId: string): void {
    const resolvedId = this.resolveAgentId(agentId);
    const agent = this.agents.get(resolvedId);
    const now = Date.now();
    if (agent) {
      agent.status = "error";
      agent.lastUpdateTime = now;
      agent.completionOrder = this.completedAgentCount;
      this.completedAgentCount++;

      logger.debug(
        `[StatusBar] Agent ERRORED`,
        JSON.stringify({
          timestamp: now,
          agentId,
          canonicalAgentId: resolvedId,
          isMain: agent.isMain,
          completionOrder: agent.completionOrder,
          completedAgentCount: this.completedAgentCount,
          totalAgents: this.agents.size,
        }),
      );
    } else {
      logger.warn(
        `[StatusBar] errorAgent called for unknown agent`,
        JSON.stringify({ timestamp: now, agentId }),
      );
    }
    if (this.activeAgentId === resolvedId) {
      this.activeAgentId = null;
    }
    this.agentIdAliases.delete(agentId);
    this.updateDisplay();
    this._onDidChangeAgents.fire();
  }

  /**
   * Show error state
   */
  showError(message: string): void {
    this.clearHideTimeout();
    this.statusBarItem.text = "$(error) Token limit exceeded";
    this.statusBarItem.tooltip = message;
    this.statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground",
    );
    this.statusBarItem.show();
    // Don't auto-hide errors - keep visible like other states
  }

  /**
   * Update the status bar display based on current agent state
   */
  private updateDisplay(): void {
    this.clearHideTimeout();
    const agentsArray = Array.from(this.agents.values());

    // Debug: Log all agents state
    const agentsSummary = agentsArray.map((a) => ({
      id: a.id.slice(-8),
      name: a.name,
      status: a.status,
      isMain: a.isMain,
      dimmed: a.dimmed,
      inputTokens: a.inputTokens,
      estimatedInputTokens: a.estimatedInputTokens,
      completionOrder: a.completionOrder,
      contextEdits: a.contextManagement?.appliedEdits.length ?? 0,
    }));
    logger.debug(
      `[StatusBar] updateDisplay called`,
      JSON.stringify({
        timestamp: Date.now(),
        mainAgentId: this.mainAgentId?.slice(-8),
        activeAgentId: this.activeAgentId?.slice(-8),
        completedAgentCount: this.completedAgentCount,
        agents: agentsSummary,
      }),
    );

    let mainAgent = this.mainAgentId ? this.agents.get(this.mainAgentId) : null;

    // If mainAgentId is stale (agent was removed), find the most recent main agent
    if (!mainAgent && this.agents.size > 0) {
      const mainAgents = agentsArray.filter((a) => a.isMain);
      if (mainAgents.length > 0) {
        // Use the most recently updated main agent
        mainAgent = mainAgents.reduce((latest, a) =>
          a.lastUpdateTime > latest.lastUpdateTime ? a : latest,
        );
        this.mainAgentId = mainAgent.id;
      }
    }

    const hasStreamingAgents = agentsArray.some(
      (a) => a.status === "streaming",
    );

    const hasSummarizingAgents = agentsArray.some(
      (a) => a.status === "streaming" && a.isSummarization === true,
    );

    const hasServerCompaction =
      (mainAgent?.contextManagement?.appliedEdits.length ?? 0) > 0;

    let icon = "$(debug-breakpoint-function)";
    if (hasSummarizingAgents) {
      icon = "$(sync~spin)";
    } else if (hasStreamingAgents) {
      icon = "$(loading~spin)";
    }

    let mainText = "";

    if (mainAgent) {
      const display = getDisplayTokens(mainAgent);
      if (display) {
        mainText = this.formatAgentUsage(mainAgent);

        const showCompactionSuffix =
          (mainAgent.summarizationFadeTurns !== undefined &&
            mainAgent.summarizationFadeTurns > 0) ||
          hasServerCompaction;

        if (showCompactionSuffix) {
          const serverFreed =
            mainAgent.contextManagement?.appliedEdits.reduce(
              (t, e) => t + e.clearedInputTokens,
              0,
            ) ?? 0;
          const summarizationFreed = mainAgent.summarizationReduction ?? 0;
          const totalFreed = serverFreed + summarizationFreed;
          if (totalFreed > 0) {
            mainText += ` ↓${formatTokens(totalFreed)}`;
          }
        }
      }
    }

    if (!mainText && hasStreamingAgents) {
      if (hasSummarizingAgents) {
        this.statusBarItem.text = "$(sync~spin) summarizing...";
      } else {
        this.statusBarItem.text = "$(loading~spin) streaming...";
      }
      this.statusBarItem.tooltip = undefined;
      this.statusBarItem.show();
      return;
    }

    if (mainText) {
      this.statusBarItem.text = `${icon} ${mainText}`.trim();
      this.statusBarItem.tooltip = undefined;
      this.setBackgroundColor(mainAgent);
      this.statusBarItem.show();
    } else {
      this.hide();
    }
  }

  /**
   * Format usage for a single agent
   */
  private formatAgentUsage(agent: AgentEntry): string {
    const display = getDisplayTokens(agent);
    const inputTokens = display?.value ?? 0;
    const prefix = display?.isEstimate ? "~" : "";
    const input = formatTokens(inputTokens);

    if (agent.maxInputTokens) {
      const max = formatTokens(agent.maxInputTokens);
      const pct = Math.round((inputTokens / agent.maxInputTokens) * 100);
      return `${prefix}${input}/${max} ${pct.toString()}%`;
    }

    return `${prefix}${input}`;
  }

  /**
   * Set background color based on usage percentage
   */
  private setBackgroundColor(agent: AgentEntry | null | undefined): void {
    if (!agent?.maxInputTokens) {
      this.statusBarItem.backgroundColor = undefined;
      return;
    }

    const display = getDisplayTokens(agent);
    const tokens = display?.value ?? 0;
    const percentage = Math.round((tokens / agent.maxInputTokens) * 100);

    if (percentage >= 90) {
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground",
      );
    } else if (percentage >= 75) {
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.prominentBackground",
      );
    } else {
      this.statusBarItem.backgroundColor = undefined;
    }
  }

  /**
   * Check if an agent has children still in the tree or pending claims
   */
  private hasChildrenInTree(agent: AgentEntry): boolean {
    // An agent is a parent if other agents reference its conversationId or agentTypeHash
    const parentHash = agent.conversationId ?? agent.agentTypeHash;
    if (!parentHash) return false;

    // Check for existing children
    for (const [, other] of this.agents) {
      if (other.parentConversationHash === parentHash) {
        return true;
      }
    }

    // Also check for pending claims that reference this agent as parent
    // This prevents removing a parent before its claimed children start
    for (const claim of this.claimRegistry.getClaims()) {
      if (
        claim.parentConversationHash === parentHash ||
        claim.parentAgentTypeHash === parentHash
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Age agents based on completed request count (dim and remove old agents)
   */
  private ageAgents(): void {
    const agentsToRemove: string[] = [];
    const agentsDimmed: string[] = [];

    for (const [id, agent] of this.agents) {
      // Skip streaming agents
      if (agent.status === "streaming") continue;
      // Skip agents without completion order
      if (agent.completionOrder === undefined) continue;
      // CRITICAL: Never remove the CURRENT main agent - it anchors the tree
      if (this.mainAgentId === id) continue;
      // Don't remove agents that have children still in the tree
      if (this.hasChildrenInTree(agent)) continue;

      // Calculate how many agents have completed since this one
      const agentAge = this.completedAgentCount - agent.completionOrder - 1;

      if (agentAge >= AGENT_REMOVE_AFTER_REQUESTS) {
        agentsToRemove.push(id);
      } else if (agentAge >= AGENT_DIM_AFTER_REQUESTS && !agent.dimmed) {
        agent.dimmed = true;
        agentsDimmed.push(id);
      }
    }

    for (const id of agentsToRemove) {
      const agent = this.agents.get(id);
      if (agent) {
        this.removeIdentityMappings(agent);
      }
      this.removeAliasesForAgent(id);
      this.agents.delete(id);
      if (this.mainAgentId === id) {
        this.mainAgentId = null;
      }
    }

    if (agentsDimmed.length > 0 || agentsToRemove.length > 0) {
      logger.debug(
        `[StatusBar] Agents aged`,
        JSON.stringify({
          timestamp: Date.now(),
          dimmed: agentsDimmed.map((id) => id.slice(-8)),
          removed: agentsToRemove.map((id) => id.slice(-8)),
          completedAgentCount: this.completedAgentCount,
          remainingAgents: this.agents.size,
        }),
      );
    }
  }

  /**
   * Clean up stale agents (periodic check)
   */
  private cleanupStaleAgents(): void {
    const countBefore = this.agents.size;
    this.ageAgents();

    // If we removed agents, update display and notify listeners
    if (this.agents.size < countBefore) {
      this.updateDisplay();
      this._onDidChangeAgents.fire();
    }
  }

  /**
   * Schedule auto-hide - currently disabled to keep status bar always visible
   * The status bar provides valuable context about token usage throughout the session
   */
  private scheduleHide(): void {
    // Don't auto-hide - keep status bar visible as long as there's data to show
    // Users can see token usage history in the tooltip
    this.clearHideTimeout();
  }

  private clearHideTimeout(): void {
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
  }

  hide(): void {
    this.statusBarItem.hide();
  }

  /**
   * Get the last recorded usage
   */
  getLastUsage(): TokenUsage | null {
    return this.currentUsage;
  }

  /**
   * Clear all agents (reset state)
   */
  clearAgents(): void {
    const previousCount = this.agents.size;
    const previousClaimCount = this.claimRegistry.getPendingClaimCount();
    this.agents.clear();
    this.agentsByConversationId.clear();
    this.agentIdAliases.clear();
    this.claimRegistry.clearAll();
    this.mainAgentId = null;
    this.activeAgentId = null;
    this.lastActiveConversationId = null;
    this.completedAgentCount = 0;
    this.sessionPeakInputTokens = 0;
    logger.debug(
      `[StatusBar] All agents CLEARED`,
      JSON.stringify({
        timestamp: Date.now(),
        previousAgentCount: previousCount,
        previousClaimCount,
      }),
    );
  }

  private saveSessionStats(): void {
    if (!this.sessionStatsStore) return;

    const agents = this.getAgents();
    const mainAgent = agents.find((a) => a.isMain);

    const stats: SessionStats = {
      timestamp: Date.now(),
      agentCount: agents.length,
      mainAgentTurns: mainAgent?.turnCount ?? 0,
      maxObservedInputTokens: this.sessionPeakInputTokens,
      totalOutputTokens: agents.reduce(
        (sum, a) => sum + a.totalOutputTokens,
        0,
      ),
      modelId: mainAgent?.modelId ?? null,
    };

    // Fire and forget - don't block completion
    void this.sessionStatsStore.set(stats);
  }

  /**
   * Get all agents for debugging
   */
  getAgents(): AgentEntry[] {
    return Array.from(this.agents.values());
  }

  getMainAgentId(): string | null {
    return this.mainAgentId;
  }

  getActiveAgentId(): string | null {
    return this.activeAgentId;
  }

  /**
   * Get the conversationId of the most recently active conversation.
   * Survives idle transitions — returns the last conversation that was streaming,
   * even after it completes. Returns null only if no agent has ever had a conversationId.
   */
  getLastActiveConversationId(): string | null {
    return this.lastActiveConversationId;
  }

  /**
   * Update lastActiveConversationId when an agent becomes active.
   * Only updates for root-level agents (not subagents) to avoid
   * the sidebar flickering to a subagent's conversation.
   */
  private trackActiveConversation(agent: AgentEntry): void {
    if (agent.conversationId && !agent.parentConversationHash) {
      this.lastActiveConversationId = agent.conversationId;
    }
  }

  createDiagnosticDump(vscodeSessionId: string): DiagnosticDump {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const tree = this.createTreeSnapshot();
    const invariants = treeDiagnostics.checkInvariants(tree);
    const treeText = treeDiagnostics.createTreeText(tree);
    const pendingClaims = this.claimRegistry.getClaims().map((claim) => ({
      expectedName: claim.expectedChildAgentName,
      parentId: claim.parentConversationHash,
      expiresAt: new Date(claim.expiresAt).toISOString(),
    }));

    return {
      timestamp,
      vscodeSessionId,
      tree,
      treeText,
      invariants,
      pendingClaims,
    };
  }

  /**
   * Create a claim when parent agent calls runSubagent.
   * Called from openresponses-chat.ts when runSubagent tool call is detected.
   */
  createChildClaim(
    parentAgentId: string,
    expectedChildAgentName: string,
  ): void {
    const resolvedId = this.resolveAgentId(parentAgentId);
    const parentAgent = this.agents.get(resolvedId);
    if (!parentAgent) {
      logger.warn(
        `[StatusBar] Cannot create claim: parent agent ${parentAgentId} not found`,
      );
      return;
    }

    // Need agentTypeHash at minimum to create claim
    if (!parentAgent.agentTypeHash) {
      logger.info(
        `[StatusBar] Cannot create claim: parent missing agentTypeHash`,
        JSON.stringify({
          parentAgentId: parentAgentId.slice(-8),
        }),
      );
      return;
    }

    // Use conversationId if available (stable UUID from stateful marker),
    // otherwise fall back to agentTypeHash as provisional identifier.
    // This allows first-turn subagent calls to still create claims.
    const parentIdentifier =
      parentAgent.conversationId ?? parentAgent.agentTypeHash;

    this.claimRegistry.createClaim(
      parentIdentifier,
      parentAgent.agentTypeHash,
      expectedChildAgentName,
    );

    logger.info(
      `[StatusBar] Created child claim`,
      JSON.stringify({
        parentAgentId: parentAgentId.slice(-8),
        expectedChildAgentName,
        usingConversationId: !!parentAgent.conversationId,
        parentIdentifier: parentIdentifier.slice(0, 8),
      }),
    );

    // Tree diagnostics
    treeDiagnostics.log(
      "CLAIM_CREATED",
      {
        parentAgentId: parentAgentId.slice(-8),
        parentName: parentAgent.name,
        expectedChildAgentName,
        parentIdentifier: parentIdentifier.slice(0, 8),
        usingConversationId: !!parentAgent.conversationId,
      },
      this.createTreeSnapshot(),
      { vscodeSessionId: vscode.env.sessionId },
    );
  }

  /**
   * Try to match a new agent to a pending claim.
   * Returns the parent's conversationHash and expected child name if matched.
   */
  matchChildClaim(
    agentName: string,
    agentTypeHash: string,
  ): { parentConversationHash: string; expectedChildName: string } | null {
    return this.claimRegistry.matchClaim(agentName, agentTypeHash);
  }

  dispose(): void {
    this.clearHideTimeout();
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.claimRegistry.dispose();
    this.agents.clear();
    this._onDidChangeAgents.dispose();
    this.statusBarItem.dispose();
  }
}
