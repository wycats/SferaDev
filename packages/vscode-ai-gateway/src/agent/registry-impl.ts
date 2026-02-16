/**
 * AgentRegistryImpl - Implementation of the AgentRegistry interface
 *
 * This class manages agent state, identity resolution, and event emission.
 * It is extracted from TokenStatusBar to separate registry concerns from UI.
 *
 * State managed:
 * - agents: Map<string, AgentEntry> - all tracked agents
 * - agentsByConversationId: Map<string, AgentEntry> - lookup by stable UUID
 * - agentIdAliases: Map<string, string> - request ID to canonical ID mapping
 * - claimRegistry: ClaimRegistry - parent-child claim tracking
 * - mainAgentId, activeAgentId - current state
 * - completedAgentCount - for aging logic
 */

import * as vscode from "vscode";
import { ClaimRegistry } from "../identity/index.js";
import { logger } from "../logger.js";
import {
  createPersistenceManager,
  AGENT_STATE_STORE,
  type PersistedAgentStateMap,
  type PersistentStore,
  type PersistenceManager,
} from "../persistence/index.js";
import type {
  AgentContext,
  AgentRegistry,
  AgentRegistryDiagnosticsState,
  AgentRegistryEvent,
  StartAgentParams,
} from "./registry.js";
import {
  AGENT_CLEANUP_INTERVAL_MS,
  AGENT_DIM_AFTER_REQUESTS,
  AGENT_REMOVE_AFTER_REQUESTS,
  type AgentEntry,
  type TokenUsage,
} from "./types.js";

/**
 * Extract agent name from modelId or use fallback.
 * Matches the logic in TokenStatusBar.extractAgentName.
 *
 * For claim matching, we use a two-tier approach:
 * 1. If this could be a subagent (mainAgentExists=true), return "sub" to use FIFO claim matching
 * 2. Otherwise, extract from modelId for the main agent's display name
 *
 * The ClaimRegistry has special handling for "sub" - it matches FIFO when the
 * detected name is "sub", allowing claims to work even when we can't extract
 * the exact agent name from the modelId.
 */
function extractAgentName(
  modelId: string | undefined,
  agentId: string,
  mainAgentExists: boolean,
): string {
  // For potential subagents, use generic "sub" name
  // ClaimRegistry will match via FIFO fallback
  if (mainAgentExists) {
    return "sub";
  }

  // For main agent, try to extract from model ID
  if (modelId) {
    // Model IDs may be VS Code encoded (e.g., "m:anthropic%2Fclaude-opus-4.5")
    // Decode first to get the raw model ID (e.g., "anthropic/claude-opus-4.5")
    const decodedModelId = decodeURIComponent(
      modelId.startsWith("m:") ? modelId.slice(2) : modelId,
    );
    // Extract the model name after the provider prefix
    // Raw model IDs use either "/" or ":" as separator:
    // - "anthropic/claude-opus-4.5" -> "claude-opus-4.5"
    // - "anthropic:claude-sonnet-4" -> "claude-sonnet-4"
    const slashIdx = decodedModelId.lastIndexOf("/");
    const colonIdx = decodedModelId.lastIndexOf(":");
    const separatorIdx = Math.max(slashIdx, colonIdx);
    if (separatorIdx >= 0) {
      return decodedModelId.slice(separatorIdx + 1);
    }
    // Fall back to full decoded model ID
    return decodedModelId;
  }
  // Fall back to last 6 chars of agentId
  return agentId.slice(-6);
}

export class AgentRegistryImpl implements AgentRegistry, vscode.Disposable {
  // Core state
  private agents = new Map<string, AgentEntry>();
  private mainAgentId: string | null = null;
  private activeAgentId: string | null = null;
  private completedAgentCount = 0;

  // Event sequencing (monotonically increasing for deterministic ordering)
  private eventSequence = 0;

  // Identity tracking
  private claimRegistry = new ClaimRegistry();
  private agentsByConversationId = new Map<string, AgentEntry>();
  private agentIdAliases = new Map<string, string>();
  /** Maps agentId to VS Code chatId for causality tracking */
  private agentChatIds = new Map<string, string>();
  /** Maps agentId to parent chatId for subagent tracking */
  private agentParentChatIds = new Map<string, string>();

  // Cleanup
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  // Persistence (fresh-start: only used for getAgentContext lookups)
  private persistenceManager: PersistenceManager | null = null;
  private agentStateStore: PersistentStore<PersistedAgentStateMap> | null =
    null;

  // Event emitter
  private readonly _onDidChangeAgents =
    new vscode.EventEmitter<AgentRegistryEvent>();
  readonly onDidChangeAgents = this._onDidChangeAgents.event;

  constructor() {
    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleAgents();
    }, AGENT_CLEANUP_INTERVAL_MS);
  }

  /** Get next sequence number for event ordering */
  private nextSequence(): number {
    return this.eventSequence++;
  }

  /**
   * Initialize persistence for agent state.
   * Fresh-start: We don't restore agents, only use persisted state for
   * getAgentContext() lookups (delta estimation on resumed conversations).
   */
  initializePersistence(context: vscode.ExtensionContext): void {
    this.persistenceManager = createPersistenceManager(context);
    this.agentStateStore = this.persistenceManager.getStore(AGENT_STATE_STORE);
    logger.info("[AgentRegistry] Persistence initialized (fresh-start mode)");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────────

  startAgent(params: StartAgentParams): string {
    const {
      agentId,
      chatId,
      parentChatId,
      estimatedTokens,
      maxTokens,
      modelId,
      systemPromptHash,
      agentTypeHash,
      firstUserMessageHash,
      estimatedDeltaTokens,
      conversationId,
      isSummarization,
      firstUserMessagePreview,
    } = params;

    // Store chatId mappings for causality tracking
    if (chatId) {
      this.agentChatIds.set(agentId, chatId);
    }
    if (parentChatId) {
      this.agentParentChatIds.set(agentId, parentChatId);
    }

    const now = Date.now();

    // Check for conversation identity match (conversationId is a stable UUID)
    const existingByConversationId = conversationId
      ? this.agentsByConversationId.get(conversationId)
      : undefined;

    // Log subagent detection context
    const mainAgent = this.mainAgentId
      ? this.agents.get(this.mainAgentId)
      : null;
    const hasDifferentAgentType =
      mainAgent?.agentTypeHash !== undefined &&
      agentTypeHash !== undefined &&
      agentTypeHash !== mainAgent.agentTypeHash;
    const hasPendingClaims = this.claimRegistry.getPendingClaimCount() > 0;

    logger.info(
      `[AgentRegistry] Subagent detection check`,
      JSON.stringify({
        agentId: agentId.slice(-8),
        hasDifferentAgentType,
        hasPendingClaims,
        mainAgentTypeHash: mainAgent?.agentTypeHash?.slice(0, 8),
        thisAgentTypeHash: agentTypeHash?.slice(0, 8),
        conversationId: conversationId?.slice(0, 8),
        matchedBy: existingByConversationId ? "conversationId" : "none",
      }),
    );

    // Check claims when there's no conversationId match
    // Use modelId for name extraction (matches TokenStatusBar behavior)
    // Pass mainAgentId !== null to trigger "sub" fallback for FIFO claim matching
    const extractedName = extractAgentName(
      modelId,
      agentId,
      this.mainAgentId !== null,
    );
    const claimMatch =
      !existingByConversationId && agentTypeHash
        ? this.matchChildClaim(extractedName, agentTypeHash)
        : null;

    let canonicalAgentId: string;
    let isResume = false;

    if (claimMatch && agentTypeHash) {
      // Create child agent from claim
      canonicalAgentId = this.createChildAgent(
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
        conversationId,
        isSummarization,
        firstUserMessagePreview,
      );
    } else if (existingByConversationId) {
      // Resume existing conversation
      canonicalAgentId = this.resumeAgent(
        agentId,
        existingByConversationId,
        now,
        estimatedTokens,
        maxTokens,
        modelId,
        estimatedDeltaTokens,
        isSummarization,
      );
      isResume = true;
    } else {
      // Create new agent
      canonicalAgentId = this.createNewAgent(
        agentId,
        now,
        estimatedTokens,
        maxTokens,
        modelId,
        systemPromptHash,
        agentTypeHash,
        firstUserMessageHash,
        estimatedDeltaTokens,
        conversationId,
        isSummarization,
        firstUserMessagePreview,
      );
    }

    const agent = this.agents.get(canonicalAgentId);

    this._onDidChangeAgents.fire({
      type: "agent-started",
      sequence: this.nextSequence(),
      agentId,
      canonicalAgentId,
      chatId: this.agentChatIds.get(canonicalAgentId),
      parentChatId: this.agentParentChatIds.get(canonicalAgentId),
      conversationId: agent?.conversationId,
      agentTypeHash: agent?.agentTypeHash,
      isMain: agent?.isMain ?? false,
      isResume,
      parentConversationHash: agent?.parentConversationHash,
      timestamp: now,
    });

    return canonicalAgentId;
  }

  completeAgent(agentId: string, usage: TokenUsage): void {
    const resolvedId = this.resolveAgentId(agentId);
    const agent = this.agents.get(resolvedId);
    if (!agent) {
      logger.warn(`[AgentRegistry] Agent ${agentId} not found for completion`);
      return;
    }

    const now = Date.now();

    // Store this turn's tokens
    agent.inputTokens = usage.inputTokens;
    agent.outputTokens = usage.outputTokens;

    // Detect VS Code summarization: a significant token drop between turns
    let summarizationDetected = false;
    if (
      agent.lastActualInputTokens > 0 &&
      usage.inputTokens < agent.lastActualInputTokens * 0.7
    ) {
      const reduction = agent.lastActualInputTokens - usage.inputTokens;
      agent.summarizationDetected = true;
      // Accumulate if multiple summarizations occur
      agent.summarizationReduction =
        (agent.summarizationReduction ?? 0) + reduction;
      agent.summarizationFadeTurns = 2;
      summarizationDetected = true;

      logger.info(
        `[AgentRegistry] Summarization detected`,
        JSON.stringify({
          agentId: resolvedId.slice(-8),
          previousTokens: agent.lastActualInputTokens,
          currentTokens: usage.inputTokens,
          reduction,
          totalReduction: agent.summarizationReduction,
        }),
      );
    } else if (
      agent.summarizationFadeTurns &&
      agent.summarizationFadeTurns > 0
    ) {
      agent.summarizationFadeTurns--;
      if (agent.summarizationFadeTurns === 0) {
        agent.summarizationDetected = false;
        agent.summarizationReduction = undefined;
      }
    }

    // Update actual tokens
    agent.lastActualInputTokens = usage.inputTokens;
    agent.lastMessageCount = usage.messageCount;
    agent.totalOutputTokens += usage.outputTokens;
    agent.turnCount++;
    agent.status = "complete";
    agent.lastUpdateTime = now;
    agent.completionOrder = this.completedAgentCount;
    this.completedAgentCount++;

    // Update model info
    if (usage.maxInputTokens !== undefined) {
      agent.maxInputTokens = usage.maxInputTokens;
    }
    if (usage.modelId !== undefined) {
      agent.modelId = usage.modelId;
    }
    if (usage.contextManagement !== undefined) {
      agent.contextManagement = usage.contextManagement;
    }

    // Clear estimation state
    agent.estimatedInputTokens = undefined;
    agent.estimatedDeltaTokens = undefined;
    agent.estimationSource = "exact";

    // Clear per-turn flags (isSummarization is set during startAgent for this turn only)
    agent.isSummarization = undefined;

    // Persist agent state for cross-reload continuity
    this.saveAgentState(agent);

    // Age other agents
    this.ageAgents();

    logger.debug(
      `[AgentRegistry] Agent COMPLETED`,
      JSON.stringify({
        timestamp: now,
        agentId,
        canonicalAgentId: resolvedId,
        isMain: agent.isMain,
        turnCount: agent.turnCount,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        summarizationDetected,
      }),
    );

    this._onDidChangeAgents.fire({
      type: "agent-completed",
      sequence: this.nextSequence(),
      agentId,
      canonicalAgentId: resolvedId,
      chatId: this.agentChatIds.get(resolvedId),
      conversationId: agent.conversationId,
      usage,
      turnCount: agent.turnCount,
      summarizationDetected,
      timestamp: now,
    });
  }

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
        `[AgentRegistry] Agent ERRORED`,
        JSON.stringify({
          timestamp: now,
          agentId,
          canonicalAgentId: resolvedId,
          isMain: agent.isMain,
        }),
      );

      this._onDidChangeAgents.fire({
        type: "agent-errored",
        sequence: this.nextSequence(),
        agentId,
        canonicalAgentId: resolvedId,
        chatId: this.agentChatIds.get(resolvedId),
        conversationId: agent.conversationId,
        timestamp: now,
      });
    }
  }

  getAgents(): AgentEntry[] {
    return Array.from(this.agents.values());
  }

  getAgentTurnCount(agentId: string): number {
    const resolvedId = this.resolveAgentId(agentId);
    const agent = this.agents.get(resolvedId);
    return agent?.turnCount ?? 0;
  }

  getAgentContext(conversationId: string): AgentContext | undefined {
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

  updateAgentActivity(agentId: string): void {
    const resolvedId = this.resolveAgentId(agentId);
    const agent = this.agents.get(resolvedId);
    if (agent?.status === "streaming") {
      agent.lastUpdateTime = Date.now();
    }
  }

  /**
   * Get persisted turn count for a conversation (cross-reload continuity).
   */
  getPersistedTurnCount(conversationId: string | undefined): number {
    if (!conversationId || !this.agentStateStore) return 0;
    const persisted = this.agentStateStore.get().entries[conversationId];
    return persisted?.turnCount ?? 0;
  }

  syncAgentTurnCount(conversationId: string, turnCount: number): void {
    const agent = this.agentsByConversationId.get(conversationId);
    if (agent && agent.turnCount < turnCount) {
      logger.info(
        `[AgentRegistry] Syncing agent turnCount`,
        JSON.stringify({
          conversationId: conversationId.slice(0, 8),
          oldTurnCount: agent.turnCount,
          newTurnCount: turnCount,
        }),
      );
      agent.turnCount = turnCount;
      this.saveAgentState(agent);

      this._onDidChangeAgents.fire({
        type: "agent-updated",
        sequence: this.nextSequence(),
        agentId: agent.id,
        canonicalAgentId: agent.id,
        chatId: this.agentChatIds.get(agent.id),
        conversationId: agent.conversationId,
        updateType: "turn-count-sync",
        timestamp: Date.now(),
      });
    }
  }

  createChildClaim(
    parentAgentId: string,
    expectedChildAgentName: string,
  ): void {
    const resolvedId = this.resolveAgentId(parentAgentId);
    const parentAgent = this.agents.get(resolvedId);
    if (!parentAgent) {
      logger.warn(
        `[AgentRegistry] Cannot create claim: parent agent ${parentAgentId} not found`,
      );
      return;
    }

    if (!parentAgent.agentTypeHash) {
      logger.info(
        `[AgentRegistry] Cannot create claim: parent missing agentTypeHash`,
        JSON.stringify({ parentAgentId: parentAgentId.slice(-8) }),
      );
      return;
    }

    const parentIdentifier =
      parentAgent.conversationId ?? parentAgent.agentTypeHash;

    this.claimRegistry.createClaim(
      parentIdentifier,
      parentAgent.agentTypeHash,
      expectedChildAgentName,
    );

    logger.info(
      `[AgentRegistry] Created child claim`,
      JSON.stringify({
        parentAgentId: parentAgentId.slice(-8),
        parentIdentifier: parentIdentifier.slice(0, 8),
        expectedChildAgentName,
      }),
    );
  }

  clearAgents(): void {
    const now = Date.now();
    this.agents.clear();
    this.agentsByConversationId.clear();
    this.agentIdAliases.clear();
    this.agentChatIds.clear();
    this.agentParentChatIds.clear();
    this.claimRegistry.clearAll();
    this.mainAgentId = null;
    this.activeAgentId = null;
    this.completedAgentCount = 0;

    this._onDidChangeAgents.fire({
      type: "agents-cleared",
      sequence: this.nextSequence(),
      timestamp: now,
    });
  }

  updateAgentTitle(conversationId: string, title: string): void {
    const agent = this.agentsByConversationId.get(conversationId);
    if (!agent) {
      logger.warn(
        `[AgentRegistry] Cannot update title: agent not found for conversationId ${conversationId.slice(0, 8)}`,
      );
      return;
    }

    agent.generatedTitle = title;
    agent.lastUpdateTime = Date.now();

    logger.info(
      `[AgentRegistry] Updated agent title`,
      JSON.stringify({
        conversationId: conversationId.slice(0, 8),
        title: title.slice(0, 30),
      }),
    );

    this._onDidChangeAgents.fire({
      type: "agent-updated",
      sequence: this.nextSequence(),
      agentId: agent.id,
      canonicalAgentId: agent.id,
      chatId: this.agentChatIds.get(agent.id),
      conversationId: agent.conversationId,
      updateType: "title-generated",
      timestamp: Date.now(),
    });
  }

  linkChildAgent(
    parentConversationId: string,
    childConversationId: string,
  ): void {
    const parentAgent = this.agentsByConversationId.get(parentConversationId);
    const childAgent = this.agentsByConversationId.get(childConversationId);

    if (!parentAgent) {
      logger.warn(
        `[AgentRegistry] Cannot link child: parent not found for conversationId ${parentConversationId.slice(0, 8)}`,
      );
      return;
    }

    if (!childAgent) {
      logger.warn(
        `[AgentRegistry] Cannot link child: child not found for conversationId ${childConversationId.slice(0, 8)}`,
      );
      return;
    }

    // Add child to parent's list
    parentAgent.childConversationHashes ??= [];
    if (!parentAgent.childConversationHashes.includes(childConversationId)) {
      parentAgent.childConversationHashes.push(childConversationId);
    }

    // Set parent reference on child
    childAgent.parentConversationHash = parentConversationId;

    logger.info(
      `[AgentRegistry] Linked child agent`,
      JSON.stringify({
        parentConversationId: parentConversationId.slice(0, 8),
        childConversationId: childConversationId.slice(0, 8),
      }),
    );

    this._onDidChangeAgents.fire({
      type: "agent-updated",
      sequence: this.nextSequence(),
      agentId: parentAgent.id,
      canonicalAgentId: parentAgent.id,
      chatId: this.agentChatIds.get(parentAgent.id),
      conversationId: parentAgent.conversationId,
      updateType: "child-linked",
      timestamp: Date.now(),
    });
  }

  getDiagnosticsSnapshotData(): AgentRegistryDiagnosticsState {
    return {
      agents: this.agents,
      claims: this.claimRegistry.getClaims(),
      mainAgentId: this.mainAgentId,
      activeAgentId: this.activeAgentId,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private resolveAgentId(agentId: string): string {
    return this.agentIdAliases.get(agentId) ?? agentId;
  }

  private matchChildClaim(
    agentName: string,
    agentTypeHash: string,
  ): { parentConversationHash: string; expectedChildName: string } | null {
    return this.claimRegistry.matchClaim(agentName, agentTypeHash);
  }

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
    conversationId: string | undefined,
    isSummarization: boolean | undefined,
    firstUserMessagePreview: string | undefined,
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
      modelId,
      status: "streaming",
      dimmed: false,
      isMain: false,
      systemPromptHash,
      agentTypeHash,
      parentConversationHash: claimMatch.parentConversationHash,
      firstUserMessageHash,
      firstUserMessagePreview,
      estimationSource: estimatedDeltaTokens ? "delta" : "estimated",
      conversationId,
      isSummarization,
    };

    this.agents.set(agentId, agent);
    this.activeAgentId = agentId;

    if (conversationId) {
      this.agentsByConversationId.set(conversationId, agent);
    }

    // Link parent to child
    const parentAgent = this.findAgentByConversationHash(
      claimMatch.parentConversationHash,
    );
    if (parentAgent) {
      parentAgent.childConversationHashes ??= [];
      const childHash = conversationId ?? agentTypeHash;
      if (
        childHash &&
        !parentAgent.childConversationHashes.includes(childHash)
      ) {
        parentAgent.childConversationHashes.push(childHash);
      }
    }

    logger.info(
      `[AgentRegistry] Created CHILD agent`,
      JSON.stringify({
        agentId: agentId.slice(-8),
        name: claimMatch.expectedChildName,
        parentConversationHash: claimMatch.parentConversationHash.slice(0, 8),
        conversationId: conversationId?.slice(0, 8),
      }),
    );

    return agentId;
  }

  private resumeAgent(
    agentId: string,
    existingAgent: AgentEntry,
    now: number,
    estimatedTokens: number | undefined,
    maxTokens: number | undefined,
    modelId: string | undefined,
    estimatedDeltaTokens: number | undefined,
    isSummarization: boolean | undefined,
  ): string {
    // Create alias from new request ID to canonical agent ID
    if (agentId !== existingAgent.id) {
      this.agentIdAliases.set(agentId, existingAgent.id);
    }

    // Update agent state
    existingAgent.status = "streaming";
    existingAgent.lastUpdateTime = now;
    if (estimatedTokens !== undefined) {
      existingAgent.estimatedInputTokens = estimatedTokens;
    }
    if (estimatedDeltaTokens !== undefined) {
      existingAgent.estimatedDeltaTokens = estimatedDeltaTokens;
      existingAgent.estimationSource = "delta";
    }
    if (maxTokens !== undefined) {
      existingAgent.maxInputTokens = maxTokens;
    }
    if (modelId !== undefined) {
      existingAgent.modelId = modelId;
    }
    if (isSummarization !== undefined) {
      existingAgent.isSummarization = isSummarization;
    }

    this.activeAgentId = existingAgent.id;

    logger.info(
      `[AgentRegistry] RESUMED agent`,
      JSON.stringify({
        agentId: agentId.slice(-8),
        canonicalAgentId: existingAgent.id.slice(-8),
        turnCount: existingAgent.turnCount,
        conversationId: existingAgent.conversationId?.slice(0, 8),
      }),
    );

    return existingAgent.id;
  }

  private createNewAgent(
    agentId: string,
    now: number,
    estimatedTokens: number | undefined,
    maxTokens: number | undefined,
    modelId: string | undefined,
    systemPromptHash: string | undefined,
    agentTypeHash: string | undefined,
    firstUserMessageHash: string | undefined,
    estimatedDeltaTokens: number | undefined,
    conversationId: string | undefined,
    isSummarization: boolean | undefined,
    firstUserMessagePreview: string | undefined,
  ): string {
    // This is createNewAgent, so there's no main agent yet (or we're demoting)
    // Pass false to get the actual name from modelId
    const name = extractAgentName(modelId, agentId, false);

    // Determine if this is the main agent
    // If there's already a main agent, demote it first
    const previousMainId = this.mainAgentId;
    const isMain = true; // New non-subagent conversations become main

    // Demote previous main agent if exists
    if (previousMainId && previousMainId !== agentId) {
      const previousMain = this.agents.get(previousMainId);
      if (previousMain) {
        previousMain.isMain = false;
        logger.info(
          `[AgentRegistry] Demoted previous main agent`,
          JSON.stringify({
            previousMainId: previousMainId.slice(-8),
            newMainId: agentId.slice(-8),
          }),
        );
        // Emit demotion event
        this._onDidChangeAgents.fire({
          type: "agent-updated",
          sequence: this.nextSequence(),
          agentId: previousMainId,
          canonicalAgentId: previousMainId,
          chatId: this.agentChatIds.get(previousMainId),
          conversationId: previousMain.conversationId,
          updateType: "main-demoted",
          timestamp: Date.now(),
        });
      }
    }

    const agent: AgentEntry = {
      id: agentId,
      name,
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
      modelId,
      status: "streaming",
      dimmed: false,
      isMain,
      systemPromptHash,
      agentTypeHash,
      firstUserMessageHash,
      firstUserMessagePreview,
      estimationSource: estimatedDeltaTokens ? "delta" : "estimated",
      conversationId,
      isSummarization,
    };

    this.agents.set(agentId, agent);
    this.activeAgentId = agentId;
    this.mainAgentId = agentId;

    if (conversationId) {
      this.agentsByConversationId.set(conversationId, agent);
    }

    logger.info(
      `[AgentRegistry] Created NEW agent`,
      JSON.stringify({
        agentId: agentId.slice(-8),
        name,
        isMain,
        conversationId: conversationId?.slice(0, 8),
        agentTypeHash: agentTypeHash?.slice(0, 8),
      }),
    );

    return agentId;
  }

  private findAgentByConversationHash(hash: string): AgentEntry | undefined {
    // First try direct conversationId lookup
    const byConversationId = this.agentsByConversationId.get(hash);
    if (byConversationId) return byConversationId;

    // Fall back to agentTypeHash match
    for (const agent of this.agents.values()) {
      if (agent.agentTypeHash === hash || agent.conversationId === hash) {
        return agent;
      }
    }
    return undefined;
  }

  private hasChildrenInTree(agent: AgentEntry): boolean {
    const parentHash = agent.conversationId ?? agent.agentTypeHash;
    if (!parentHash) return false;

    // Check for existing children
    for (const other of this.agents.values()) {
      if (other.parentConversationHash === parentHash) {
        return true;
      }
    }

    // Check for pending claims
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

  private ageAgents(): void {
    const agentsToRemove: string[] = [];
    const agentsDimmed: string[] = [];

    for (const [id, agent] of this.agents) {
      if (agent.status === "streaming") continue;
      if (agent.completionOrder === undefined) continue;
      if (this.mainAgentId === id) continue;
      if (this.hasChildrenInTree(agent)) continue;

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
        // Emit removal event before deleting
        this._onDidChangeAgents.fire({
          type: "agent-removed",
          sequence: this.nextSequence(),
          agentId: id,
          chatId: this.agentChatIds.get(id),
          conversationId: agent.conversationId,
          reason: "aged",
          timestamp: Date.now(),
        });
        this.removeIdentityMappings(agent);
      }
      this.removeAliasesForAgent(id);
      this.agentChatIds.delete(id);
      this.agentParentChatIds.delete(id);
      this.agents.delete(id);
      if (this.mainAgentId === id) {
        this.mainAgentId = null;
      }
    }

    if (agentsDimmed.length > 0 || agentsToRemove.length > 0) {
      logger.debug(
        `[AgentRegistry] Agents aged`,
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
   * Persist agent state for cross-reload continuity.
   * Only saves if persistence is initialized and agent has a conversationId.
   */
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
          fetchedAt: Date.now(),
          ...(agent.modelId != null ? { modelId: agent.modelId } : {}),
          ...(agent.summarizationDetected && agent.summarizationReduction
            ? {
                summarizationDetected: true,
                summarizationReduction: agent.summarizationReduction,
              }
            : {}),
        },
      },
    }));
  }

  private cleanupStaleAgents(): void {
    const countBefore = this.agents.size;
    this.ageAgents();

    // If we removed agents, fire a generic change event
    // (The specific removal events were already fired in ageAgents)
    if (this.agents.size < countBefore) {
      // Note: We don't fire an event here because ageAgents doesn't
      // currently fire individual removal events. This is a simplification
      // that can be enhanced later if needed.
    }
  }

  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.claimRegistry.dispose();
    this.agents.clear();
    this._onDidChangeAgents.dispose();
  }
}
