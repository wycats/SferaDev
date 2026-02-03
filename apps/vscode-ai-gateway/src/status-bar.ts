import * as vscode from "vscode";
import {
  DiagnosticDump,
  treeDiagnostics,
  TreeDiagnostics,
} from "./diagnostics/tree-diagnostics.js";
import {
  ClaimRegistry,
  computeConversationHash,
  hashFirstAssistantResponse,
} from "./identity/index.js";
import { logger } from "./logger";
import {
  createPersistenceManager,
  SESSION_STATS_STORE,
  type SessionStats,
} from "./persistence/index.js";
import type {
  PersistentStore,
  PersistenceManager,
} from "./persistence/index.js";

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
  /** Maximum observed input tokens across all turns (each turn includes full context) */
  maxObservedInputTokens: number;
  /** Cumulative output tokens across all turns in this conversation */
  totalOutputTokens: number;
  /** Number of turns (request/response cycles) in this conversation */
  turnCount: number;
  maxInputTokens?: number | undefined;
  estimatedInputTokens?: number | undefined;
  modelId?: string | undefined;
  status: "streaming" | "complete" | "error";
  contextManagement?: ContextManagementInfo | undefined;
  /** Whether this agent has been dimmed due to inactivity */
  dimmed: boolean;
  /** Is this the main/primary agent (first in conversation)? */
  isMain: boolean;
  /** Order in which this agent completed (for aging) */
  completionOrder?: number | undefined;
  /** Hash of system prompt - used to detect main vs subagent */
  systemPromptHash?: string | undefined;
  // Identity tracking (RFC 00033)
  /** Computed once at conversation start from systemPromptHash + toolSetHash */
  agentTypeHash?: string | undefined;
  /** Computed after first response; null until then */
  conversationHash?: string | null | undefined;
  /** Parent's conversationHash if this is a subagent */
  parentConversationHash?: string | null | undefined;
  /** Conversation hashes of child agents spawned by this agent */
  childConversationHashes?: string[] | undefined;
  /** Hash of first user message (computed at conversation start) */
  firstUserMessageHash?: string | undefined;
  /** Hash of first assistant response (computed after first response) */
  firstAssistantResponseHash?: string | null | undefined;
}

/** Agent aging configuration */
const AGENT_DIM_AFTER_REQUESTS = 2; // Dim after 2 newer agents complete
const AGENT_REMOVE_AFTER_REQUESTS = 5; // Remove after 5 newer agents complete
const AGENT_CLEANUP_INTERVAL_MS = 2_000; // Check for stale agents every 2 seconds

/**
 * Configuration interface (subset of ConfigService)
 */
export interface StatusBarConfig {
  showOutputTokens: boolean;
}

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
 * - Main agent: "52k/128k" (input/max)
 * - With subagent active: "52k/128k | ▸ recon 8k/128k"
 * - With compaction: "$(fold) 52k/128k ↓15k"
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
  /** System prompt hash of the main agent - used to detect subagents */
  private mainSystemPromptHash: string | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private completedAgentCount = 0;

  // Configuration
  private config: StatusBarConfig = { showOutputTokens: false };

  // Estimation state tracking
  private estimationStates = new Map<string, EstimationState>();

  private persistenceManager: PersistenceManager | null = null;
  private sessionStatsStore: PersistentStore<SessionStats> | null = null;

  // Event emitter for agent tree updates
  private readonly _onDidChangeAgents = new vscode.EventEmitter<void>();
  // Claim registry for parent-child linking (RFC 00033)
  private claimRegistry = new ClaimRegistry();
  // Conversation hash lookup (deduplication + hierarchy)
  private agentsByConversationHash = new Map<string, AgentEntry>();
  // Partial identity lookup (systemPromptHash + firstUserMessageHash)
  private agentsByPartialKey = new Map<string, AgentEntry>();
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
    this.statusBarItem.command = "vercelAiGateway.showTokenDetails";
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
   * Update configuration
   */
  setConfig(config: StatusBarConfig): void {
    this.config = config;
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
    if (agent.conversationHash) {
      this.agentsByConversationHash.delete(agent.conversationHash);
    }
    if (agent.systemPromptHash && agent.firstUserMessageHash) {
      const partialKey = `${agent.systemPromptHash}:${agent.firstUserMessageHash}`;
      const mapped = this.agentsByPartialKey.get(partialKey);
      if (mapped?.id === agent.id) {
        this.agentsByPartialKey.delete(partialKey);
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
   * Extracted to ensure claim-matched children are NEVER merged via partialKey.
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
    partialKey: string | null,
    claimMatch: { parentConversationHash: string; expectedChildName: string },
  ): string {
    const agent: AgentEntry = {
      id: agentId,
      name: claimMatch.expectedChildName,
      startTime: now,
      lastUpdateTime: now,
      inputTokens: 0,
      outputTokens: 0,
      maxObservedInputTokens: 0,
      totalOutputTokens: 0,
      turnCount: 0,
      maxInputTokens: maxTokens,
      estimatedInputTokens: estimatedTokens,
      modelId,
      status: "streaming",
      dimmed: false,
      isMain: false,
      systemPromptHash,
      agentTypeHash,
      firstUserMessageHash,
      parentConversationHash: claimMatch.parentConversationHash,
    };

    this.agents.set(agentId, agent);
    this.agentIdAliases.set(agentId, agentId);
    if (partialKey) {
      this.agentsByPartialKey.set(partialKey, agent);
    }
    this.activeAgentId = agentId;

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
        earlyClaimMatch: true, // Indicates this was matched BEFORE partialKey check
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
   * @param systemPromptHash Hash of the system prompt - used to detect subagents
   */
  startAgent(
    agentId: string,
    estimatedTokens?: number,
    maxTokens?: number,
    modelId?: string,
    systemPromptHash?: string,
    agentTypeHash?: string,
    firstUserMessageHash?: string,
  ): string {
    const now = Date.now();

    const partialKey =
      systemPromptHash && firstUserMessageHash
        ? `${systemPromptHash}:${firstUserMessageHash}`
        : null;

    // CRITICAL FIX: Check for pending claims FIRST, BEFORE partialKey matching.
    //
    // The bug: If a child agent has the same systemPromptHash AND agentTypeHash
    // as the parent (which can happen when VS Code injects summaries), the old
    // `couldBeSubagent` check would be false, and the child would be merged
    // into the parent via partialKey matching.
    //
    // The fix: Always check for claim matches when there are pending claims,
    // regardless of hash similarity. If a parent called runSubagent, the next
    // request should be treated as a potential child.
    const hasPendingClaims = this.claimRegistry.getPendingClaimCount() > 0;

    // Log subagent detection context for debugging
    const mainAgent = this.mainAgentId
      ? this.agents.get(this.mainAgentId)
      : null;
    const hasDifferentSystemPrompt =
      this.mainSystemPromptHash !== null &&
      systemPromptHash !== undefined &&
      systemPromptHash !== this.mainSystemPromptHash;
    const hasDifferentAgentType =
      mainAgent?.agentTypeHash !== undefined &&
      agentTypeHash !== undefined &&
      agentTypeHash !== mainAgent.agentTypeHash;

    logger.info(
      `[StatusBar] Subagent detection check`,
      JSON.stringify({
        agentId: agentId.slice(-8),
        hasDifferentSystemPrompt,
        hasDifferentAgentType,
        hasPendingClaims,
        mainAgentTypeHash: mainAgent?.agentTypeHash?.slice(0, 8),
        thisAgentTypeHash: agentTypeHash?.slice(0, 8),
        mainSystemPromptHash: this.mainSystemPromptHash?.slice(0, 8),
        thisSystemPromptHash: systemPromptHash?.slice(0, 8),
      }),
    );

    // Check for claim match FIRST - if there's a pending claim, this could be a child
    // regardless of whether the hashes match the parent
    if (hasPendingClaims && agentTypeHash) {
      const extractedName = this.extractAgentName(agentId, modelId, false);
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
          partialKey,
          claimMatch,
        );
      }
    }

    // Now check for partialKey match (resume existing agent)
    // This only happens if there was no claim match
    const existingAgent = partialKey
      ? this.agentsByPartialKey.get(partialKey)
      : undefined;

    if (existingAgent) {
      this.agentIdAliases.set(agentId, existingAgent.id);
      existingAgent.status = "streaming";
      existingAgent.lastUpdateTime = now;
      existingAgent.estimatedInputTokens = estimatedTokens;
      existingAgent.maxInputTokens =
        maxTokens ?? existingAgent.maxInputTokens ?? undefined;
      existingAgent.modelId = modelId ?? existingAgent.modelId;
      existingAgent.systemPromptHash =
        systemPromptHash ?? existingAgent.systemPromptHash;
      existingAgent.agentTypeHash =
        agentTypeHash ?? existingAgent.agentTypeHash;
      existingAgent.firstUserMessageHash =
        firstUserMessageHash ?? existingAgent.firstUserMessageHash;
      // Don't reset inputTokens/outputTokens - they'll be updated in completeAgent
      // Keep maxObservedInputTokens/totalOutputTokens for accumulation
      existingAgent.contextManagement = undefined;
      existingAgent.dimmed = false;
      existingAgent.completionOrder = undefined;

      if (existingAgent.isMain) {
        this.mainAgentId = existingAgent.id;
        if (systemPromptHash) {
          this.mainSystemPromptHash = systemPromptHash;
        }
      }

      this.activeAgentId = existingAgent.id;

      logger.info(
        `[StatusBar] Agent RESUMED (partialKey match)`,
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
          firstUserMessageHash: existingAgent.firstUserMessageHash?.slice(0, 8),
          partialKey: partialKey?.slice(0, 20),
          totalAgents: this.agents.size,
        }),
      );

      // Tree diagnostics
      treeDiagnostics.log(
        "AGENT_RESUMED",
        {
          agentId: agentId.slice(-8),
          canonicalAgentId: existingAgent.id.slice(-8),
          isMain: existingAgent.isMain,
          name: existingAgent.name,
          partialKey: partialKey?.slice(0, 20),
          systemPromptHash: systemPromptHash?.slice(0, 8),
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

    // Try to match a pending claim to get parent linkage and expected name
    // This must happen BEFORE determining isMain, because:
    // - If there's a claim match, this is definitely a subagent
    // - If there's no claim match and system prompt changed, it's likely still the main agent
    //   (VS Code can inject conversation summaries that change the system prompt hash)
    const claimMatch =
      agentTypeHash !== undefined
        ? this.matchChildClaim(extractedAgentName, agentTypeHash)
        : null;

    // Determine if this is the main agent or a subagent
    // Main agent: first agent OR same system prompt hash as main OR no claim match
    // Subagent: different system prompt hash AND has a claim match
    let isMain: boolean;
    if (this.mainAgentId === null) {
      // First agent is always main
      isMain = true;
      this.mainAgentId = agentId;
      if (systemPromptHash) {
        this.mainSystemPromptHash = systemPromptHash;
      }
    } else if (claimMatch !== null) {
      // If there's a claim match, this is definitely a subagent
      // (parent agent called runSubagent and created a claim for this child)
      isMain = false;
    } else if (systemPromptHash && this.mainSystemPromptHash) {
      // No claim match - check if system prompt hash matches
      if (systemPromptHash === this.mainSystemPromptHash) {
        // Same hash, definitely main agent
        isMain = true;
        this.mainAgentId = agentId;
      } else {
        // Different hash but no claim - likely main agent with updated system prompt
        // (VS Code can inject conversation summaries that change the hash)
        // Update the main system prompt hash to track the new value
        isMain = true;
        this.mainAgentId = agentId;
        this.mainSystemPromptHash = systemPromptHash;
        logger.info(
          `[StatusBar] Main agent system prompt hash updated: ${this.mainSystemPromptHash?.slice(0, 8)} -> ${systemPromptHash.slice(0, 8)}`,
        );
      }
    } else if (systemPromptHash && !this.mainSystemPromptHash) {
      // First request had no hash, but this one does - treat as new main
      isMain = true;
      this.mainAgentId = agentId;
      this.mainSystemPromptHash = systemPromptHash;
    } else {
      // No hash info - fall back to first-agent-is-main behavior
      isMain = false;
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
      maxObservedInputTokens: 0,
      totalOutputTokens: 0,
      turnCount: 0,
      maxInputTokens: maxTokens,
      estimatedInputTokens: estimatedTokens,
      modelId,
      status: "streaming",
      dimmed: false,
      isMain,
      systemPromptHash,
      agentTypeHash,
      firstUserMessageHash,
      parentConversationHash,
    };

    this.agents.set(agentId, agent);
    this.agentIdAliases.set(agentId, agentId);
    if (partialKey) {
      this.agentsByPartialKey.set(partialKey, agent);
    }
    this.activeAgentId = agentId;

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
        mainSystemPromptHash: this.mainSystemPromptHash?.slice(0, 8),
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
  completeAgent(
    agentId: string,
    usage: TokenUsage,
    firstAssistantResponseText?: string,
  ): void {
    const resolvedId = this.resolveAgentId(agentId);
    const agent = this.agents.get(resolvedId);
    if (!agent) {
      logger.warn(`Agent ${agentId} not found for completion`);
      return;
    }

    // Store this turn's tokens
    agent.inputTokens = usage.inputTokens;
    agent.outputTokens = usage.outputTokens;
    // Track max input (each turn's input includes full context, so max = current context size)
    // Accumulate output (each turn generates new tokens)
    agent.maxObservedInputTokens = Math.max(
      agent.maxObservedInputTokens,
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
    agent.completionOrder = this.completedAgentCount;

    if (
      !agent.conversationHash &&
      agent.agentTypeHash &&
      agent.firstUserMessageHash &&
      firstAssistantResponseText
    ) {
      const firstAssistantResponseHash = hashFirstAssistantResponse(
        firstAssistantResponseText,
      );
      agent.firstAssistantResponseHash = firstAssistantResponseHash;
      const newConversationHash = computeConversationHash(
        agent.agentTypeHash,
        agent.firstUserMessageHash,
        firstAssistantResponseHash,
      );
      agent.conversationHash = newConversationHash;
      this.agentsByConversationHash.set(newConversationHash, agent);

      // Update any children that were linked via provisional agentTypeHash
      // This handles first-turn subagent calls where the parent didn't have
      // a conversationHash yet when the claim was created
      this.reconcileProvisionalChildren(
        agent.agentTypeHash,
        newConversationHash,
      );
    }

    this.completedAgentCount++;
    this.currentUsage = usage;

    // Save session stats
    this.saveSessionStats();

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
        conversationHash: agent.conversationHash?.slice(0, 8),
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

    // Build main part of display
    let mainText = "";
    let icon = "$(symbol-number)";

    if (mainAgent) {
      const hasCompaction =
        (mainAgent.contextManagement?.appliedEdits.length ?? 0) > 0;
      if (hasCompaction) {
        icon = "$(fold)";
      }

      if (mainAgent.status === "streaming") {
        icon = "$(loading~spin)";
        if (mainAgent.estimatedInputTokens && mainAgent.maxInputTokens) {
          const pct = this.formatPercentage(
            mainAgent.estimatedInputTokens,
            mainAgent.maxInputTokens,
          );
          mainText = `~${this.formatTokenCount(mainAgent.estimatedInputTokens)}/${this.formatTokenCount(mainAgent.maxInputTokens)} (${pct})`;
        } else {
          mainText = "streaming...";
        }
      } else {
        mainText = this.formatAgentUsage(mainAgent);
      }

      // Add compaction suffix
      if (hasCompaction) {
        const freed =
          mainAgent.contextManagement?.appliedEdits.reduce(
            (t, e) => t + e.clearedInputTokens,
            0,
          ) ?? 0;
        // Use unpadded format for compaction suffix since it's less critical
        mainText += ` ↓${this.formatTokenCount(freed, false)}`;
      }
    }

    // Build subagent part - find the most relevant subagent to display
    // Priority: most recently active streaming subagent > most recently completed subagent
    let subagentText = "";
    const subagents = agentsArray.filter((a) => !a.isMain);

    // Find streaming subagents and pick the one with most recent activity (lastUpdateTime)
    const streamingSubagents = subagents.filter(
      (a) => a.status === "streaming",
    );
    const streamingSubagent =
      streamingSubagents.length > 0
        ? streamingSubagents.reduce((latest, a) =>
            a.lastUpdateTime > latest.lastUpdateTime ? a : latest,
          )
        : null;

    // Fall back to most recently completed subagent
    const completedSubagents = subagents.filter((a) => a.status === "complete");
    const mostRecentCompletedSubagent =
      completedSubagents.length > 0
        ? completedSubagents.reduce((latest, a) =>
            a.lastUpdateTime > latest.lastUpdateTime ? a : latest,
          )
        : null;

    const subagentToShow = streamingSubagent ?? mostRecentCompletedSubagent;

    // Debug logging for subagent selection
    if (subagents.length > 0) {
      logger.debug(
        `[StatusBar] Subagent selection`,
        JSON.stringify({
          subagentCount: subagents.length,
          streamingCount: streamingSubagents.length,
          completedCount: completedSubagents.length,
          subagents: subagents.map((s) => ({
            id: s.id.slice(-12),
            status: s.status,
            isMain: s.isMain,
            estimatedInputTokens: s.estimatedInputTokens,
            inputTokens: s.inputTokens,
            startTime: s.startTime,
            lastUpdateTime: s.lastUpdateTime,
          })),
          selectedSubagentId: subagentToShow?.id.slice(-12),
          selectedStatus: subagentToShow?.status,
        }),
      );
    }

    if (subagentToShow) {
      if (subagentToShow.status === "streaming") {
        // Streaming: show estimate with ~ prefix
        if (
          subagentToShow.estimatedInputTokens &&
          subagentToShow.maxInputTokens
        ) {
          const pct = this.formatPercentage(
            subagentToShow.estimatedInputTokens,
            subagentToShow.maxInputTokens,
          );
          subagentText = `▸ ${subagentToShow.name} ~${this.formatTokenCount(subagentToShow.estimatedInputTokens)}/${this.formatTokenCount(subagentToShow.maxInputTokens)} (${pct})`;
        } else {
          subagentText = `▸ ${subagentToShow.name}...`;
        }
      } else {
        // Completed: show actual usage
        subagentText = `${subagentToShow.name}: ${this.formatAgentUsage(subagentToShow)}`;
      }
    }

    // Combine main and subagent text with separator only if both exist
    // Check if any agents are still streaming - don't hide if so
    const hasStreamingAgents = agentsArray.some(
      (a) => a.status === "streaming",
    );
    const separator = mainText && subagentText ? " | " : "";
    const combinedText = `${mainText}${separator}${subagentText}`;

    if (combinedText) {
      this.statusBarItem.text = `${icon} ${combinedText}`.trim();
      this.statusBarItem.tooltip = this.buildTooltip();
      this.setBackgroundColor(mainAgent);
      this.statusBarItem.show();
    } else if (hasStreamingAgents) {
      // Agents are streaming but we couldn't build display text
      // Show a generic streaming indicator to avoid flickering
      this.statusBarItem.text = "$(loading~spin) streaming...";
      this.statusBarItem.tooltip = this.buildTooltip();
      this.statusBarItem.show();
    } else {
      this.hide();
    }
  }

  /**
   * Format usage for a single agent
   */
  private formatAgentUsage(agent: AgentEntry): string {
    // Use accumulated totals for multi-turn conversations
    const inputTokens =
      agent.turnCount > 1 ? agent.maxObservedInputTokens : agent.inputTokens;
    const outputTokens =
      agent.turnCount > 1 ? agent.totalOutputTokens : agent.outputTokens;
    const input = this.formatTokenCount(inputTokens);

    if (agent.maxInputTokens) {
      const max = this.formatTokenCount(agent.maxInputTokens);
      if (this.config.showOutputTokens) {
        return `${input}/${max} (${this.formatTokenCount(outputTokens)} out)`;
      }
      return `${input}/${max}`;
    }

    if (this.config.showOutputTokens) {
      return `${input} in, ${this.formatTokenCount(outputTokens)} out`;
    }
    return `${input} in`;
  }

  /**
   * Set background color based on usage percentage
   */
  private setBackgroundColor(agent: AgentEntry | null | undefined): void {
    if (!agent?.maxInputTokens) {
      this.statusBarItem.backgroundColor = undefined;
      return;
    }

    const tokens =
      agent.status === "streaming"
        ? (agent.estimatedInputTokens ?? 0)
        : agent.inputTokens;
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
   * Build tooltip with all agent details
   */
  private buildTooltip(): string {
    const lines: string[] = [];

    // Get all non-dimmed agents, sorted by start time
    const visibleAgents = Array.from(this.agents.values())
      .filter((a) => !a.dimmed)
      .sort((a, b) => a.startTime - b.startTime);

    logger.debug(
      `[StatusBar] buildTooltip`,
      JSON.stringify({
        timestamp: Date.now(),
        visibleCount: visibleAgents.length,
        agents: visibleAgents.map((a) => ({
          id: a.id.slice(-8),
          name: a.name,
          status: a.status,
          isMain: a.isMain,
          inputTokens: a.inputTokens,
          estimatedInputTokens: a.estimatedInputTokens,
          contextEdits: a.contextManagement?.appliedEdits.length ?? 0,
        })),
      }),
    );

    for (const agent of visibleAgents) {
      const prefix = agent.isMain ? "Main" : agent.name;
      const statusIcon =
        agent.status === "streaming"
          ? "⏳"
          : agent.status === "error"
            ? "❌"
            : "✓";

      if (agent.modelId) {
        lines.push(`${statusIcon} ${prefix} (${agent.modelId})`);
      } else {
        lines.push(`${statusIcon} ${prefix}`);
      }

      if (agent.status === "complete" || agent.status === "error") {
        // Show accumulated totals for multi-turn conversations
        if (agent.turnCount > 1) {
          lines.push(`   Turns: ${agent.turnCount.toString()}`);
          lines.push(
            `   Max Input: ${agent.maxObservedInputTokens.toLocaleString()}`,
          );
          if (this.config.showOutputTokens) {
            lines.push(
              `   Total Output: ${agent.totalOutputTokens.toLocaleString()}`,
            );
          }
          lines.push(
            `   Last Turn: ${agent.inputTokens.toLocaleString()} in, ${agent.outputTokens.toLocaleString()} out`,
          );
        } else {
          lines.push(`   Input: ${agent.inputTokens.toLocaleString()}`);
          if (this.config.showOutputTokens) {
            lines.push(`   Output: ${agent.outputTokens.toLocaleString()}`);
          }
        }
        if (agent.maxInputTokens) {
          const tokensForPct =
            agent.turnCount > 1
              ? agent.maxObservedInputTokens
              : agent.inputTokens;
          const pct = Math.round((tokensForPct / agent.maxInputTokens) * 100);
          lines.push(
            `   Context: ${pct.toString()}% of ${agent.maxInputTokens.toLocaleString()}`,
          );
        }
      } else if (agent.estimatedInputTokens) {
        lines.push(
          `   Estimated: ~${agent.estimatedInputTokens.toLocaleString()}`,
        );
      }

      // Context compaction
      const edits = agent.contextManagement?.appliedEdits ?? [];
      if (edits.length > 0) {
        lines.push("   ⚡ Context compacted:");
        for (const edit of edits) {
          lines.push(`      ${this.formatContextEdit(edit)}`);
        }
      }

      lines.push("");
    }

    if (lines.length > 0) {
      lines.pop(); // Remove trailing empty line
    }

    // Add estimation state section
    const states = Array.from(this.estimationStates.values());
    if (states.length > 0) {
      lines.push("");
      lines.push("📊 Token Estimation:");
      for (const state of states) {
        const statusIcon = state.isCurrent ? "🟢" : "🟡";
        const knownStr = state.knownTokens.toLocaleString();
        lines.push(
          `   ${statusIcon} ${state.modelFamily}: ${knownStr} tokens known`,
        );
        lines.push(
          `      (${state.knownMessageCount.toString()} messages cached)`,
        );
      }
    }

    lines.push("");
    lines.push("Click for details");

    return lines.join("\n");
  }

  /**
   * Format a single context edit
   */
  private formatContextEdit(edit: ContextManagementEdit): string {
    const freed = edit.clearedInputTokens.toLocaleString();
    switch (edit.type) {
      case "clear_tool_uses_20250919":
        if (edit.clearedToolUses !== undefined) {
          return `${edit.clearedToolUses.toString()} tool uses cleared (${freed} freed)`;
        }
        return `Tool uses cleared (${freed} freed)`;
      case "clear_thinking_20251015":
        if (edit.clearedThinkingTurns !== undefined) {
          return `${edit.clearedThinkingTurns.toString()} thinking turns cleared (${freed} freed)`;
        }
        return `Thinking turns cleared (${freed} freed)`;
      default:
        return `${String(edit.type)} (${freed} freed)`;
    }
  }

  /**
   * Check if an agent has children still in the tree or pending claims
   */
  private hasChildrenInTree(agent: AgentEntry): boolean {
    // An agent is a parent if other agents reference its conversationHash or agentTypeHash
    const parentHash = agent.conversationHash ?? agent.agentTypeHash;
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
      // CRITICAL: Never remove the main agent - it anchors the tree
      if (agent.isMain) continue;
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
   * Format token count for display.
   * Uses figure space (U+2007) padding for consistent width to prevent status bar bouncing.
   * Target widths: "XXX.Xk" (6 chars) for k values, "X.XM" (4 chars) for M values.
   */
  private formatTokenCount(count: number, padded = true): string {
    // Figure space has the same width as digits in most fonts
    const figureSpace = "\u2007";

    if (count >= 1000000) {
      const formatted = `${(count / 1000000).toFixed(1)}M`;
      // Pad to 5 chars: "X.XM" or "XX.XM"
      if (padded) {
        return formatted.padStart(5, figureSpace);
      }
      return formatted;
    }
    if (count >= 1000) {
      const formatted = `${(count / 1000).toFixed(1)}k`;
      // Pad to 6 chars: "X.Xk" → "XXX.Xk"
      if (padded) {
        return formatted.padStart(6, figureSpace);
      }
      return formatted;
    }
    // Small numbers: pad to 3 chars
    const formatted = count.toString();
    if (padded) {
      return formatted.padStart(3, figureSpace);
    }
    return formatted;
  }

  /**
   * Format percentage with consistent width (always 3 chars + %).
   * Uses figure space padding: " 5%" → "99%"
   */
  private formatPercentage(current: number, max: number): string {
    const figureSpace = "\u2007";
    const pct = Math.round((current / max) * 100);
    // Clamp to 0-100 and pad to 3 chars
    const clamped = Math.min(100, Math.max(0, pct));
    return `${clamped.toString().padStart(3, figureSpace)}%`;
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
    this.agentsByConversationHash.clear();
    this.agentsByPartialKey.clear();
    this.agentIdAliases.clear();
    this.claimRegistry.clearAll();
    this.mainAgentId = null;
    this.activeAgentId = null;
    this.mainSystemPromptHash = null;
    this.completedAgentCount = 0;
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
      maxObservedInputTokens: Math.max(
        ...agents.map((a) => a.maxObservedInputTokens),
        0,
      ),
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

  getPartialKeyMap(): ReadonlyMap<string, AgentEntry> {
    return this.agentsByPartialKey;
  }

  getMainAgentId(): string | null {
    return this.mainAgentId;
  }

  getActiveAgentId(): string | null {
    return this.activeAgentId;
  }

  createDiagnosticDump(vscodeSessionId: string): DiagnosticDump {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const tree = this.createTreeSnapshot();
    const invariants = treeDiagnostics.checkInvariants(tree);
    const treeText = treeDiagnostics.createTreeText(tree);
    const partialKeyMap = Object.fromEntries(
      Array.from(this.agentsByPartialKey.entries()).map(([key, agent]) => [
        key,
        agent.id,
      ]),
    );
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
      partialKeyMap,
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

    // Use conversationHash if available, otherwise use agentTypeHash as provisional identifier
    // This allows first-turn subagent calls to still create claims
    const parentIdentifier =
      parentAgent.conversationHash ?? parentAgent.agentTypeHash;

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
        usingConversationHash: !!parentAgent.conversationHash,
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
        usingConversationHash: !!parentAgent.conversationHash,
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

  /**
   * Reconcile children that were linked via provisional agentTypeHash.
   * Called when a parent computes its real conversationHash.
   * Updates children's parentConversationHash from the provisional ID to the real one.
   */
  private reconcileProvisionalChildren(
    provisionalId: string,
    realConversationHash: string,
  ): void {
    let reconciledCount = 0;
    for (const agent of this.agents.values()) {
      if (agent.parentConversationHash === provisionalId) {
        agent.parentConversationHash = realConversationHash;
        reconciledCount++;
      }
    }
    if (reconciledCount > 0) {
      logger.info(
        `[StatusBar] Reconciled ${reconciledCount} children from provisional ID`,
        JSON.stringify({
          provisionalId: provisionalId.slice(0, 8),
          realConversationHash: realConversationHash.slice(0, 8),
        }),
      );
      this._onDidChangeAgents.fire();
    }
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
