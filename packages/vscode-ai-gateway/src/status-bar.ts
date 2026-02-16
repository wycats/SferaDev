import * as vscode from "vscode";
import {
  DiagnosticDump,
  treeDiagnostics,
  TreeDiagnostics,
} from "./diagnostics/tree-diagnostics.js";
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
import type { AgentRegistry } from "./agent/registry.js";
import type {
  AgentEntry,
  EstimationState,
  TokenUsage,
} from "./agent/types.js";

/**
 * Status bar item that displays token usage information.
 */
export class TokenStatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private currentUsage: TokenUsage | null = null;
  private hideTimeout: ReturnType<typeof setTimeout> | null = null;

  // Estimation state tracking
  private estimationStates = new Map<string, EstimationState>();

  private persistenceManager: PersistenceManager | null = null;
  private sessionStatsStore: PersistentStore<SessionStats> | null = null;
  private agentStateStore: PersistentStore<PersistedAgentStateMap> | null =
    null;

  private readonly registry: AgentRegistry;
  private registrySubscription: vscode.Disposable | null = null;

  constructor(agentRegistry: AgentRegistry) {
    this.registry = agentRegistry;
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.statusBarItem.name = "Vercel AI Token Usage";
    this.statusBarItem.command = "vercel.ai.agentTree.focus";
    this.hide();

    this.registrySubscription = this.registry.onDidChangeAgents((event) => {
      if (event.type === "agent-completed") {
        this.currentUsage = event.usage;
        this.saveSessionStats();
      }
      this.updateDisplay();
      this.scheduleHide();
    });
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
    const context = this.registry.getAgentContext(conversationId);
    if (context) return context;

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

  private findMainAgent(agents: AgentEntry[]): AgentEntry | undefined {
    const mainAgents = agents.filter((agent) => agent.isMain);
    if (mainAgents.length === 0) {
      return undefined;
    }

    return mainAgents.reduce((latest, agent) =>
      agent.lastUpdateTime > latest.lastUpdateTime ? agent : latest,
    );
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
    const agentsArray = this.registry.getAgents();

    const agentsSummary = agentsArray.map((agent) => ({
      id: agent.id.slice(-8),
      name: agent.name,
      status: agent.status,
      isMain: agent.isMain,
      dimmed: agent.dimmed,
      inputTokens: agent.inputTokens,
      estimatedInputTokens: agent.estimatedInputTokens,
      completionOrder: agent.completionOrder,
      contextEdits: agent.contextManagement?.appliedEdits.length ?? 0,
    }));
    logger.debug(
      `[StatusBar] updateDisplay called`,
      JSON.stringify({
        timestamp: Date.now(),
        agents: agentsSummary,
      }),
    );

    const mainAgent = this.findMainAgent(agentsArray);

    const hasStreamingAgents = agentsArray.some(
      (agent) => agent.status === "streaming",
    );

    const hasSummarizingAgents = agentsArray.some(
      (agent) => agent.status === "streaming" && agent.isSummarization === true,
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
              (total, edit) => total + edit.clearedInputTokens,
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
    const input = formatTokens(inputTokens);

    if (agent.maxInputTokens) {
      const max = formatTokens(agent.maxInputTokens);
      const pct = Math.round((inputTokens / agent.maxInputTokens) * 100);
      return `${input}/${max} ${pct.toString()}%`;
    }

    return input;
  }

  /**
   * Set background color based on usage percentage
   */
  private setBackgroundColor(agent: AgentEntry | undefined): void {
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

  private saveSessionStats(): void {
    if (!this.sessionStatsStore) return;

    const agents = this.registry.getAgents();
    const mainAgent = this.findMainAgent(agents);
    const maxObservedInputTokens = agents.reduce(
      (max, agent) =>
        Math.max(max, agent.lastActualInputTokens, agent.inputTokens),
      0,
    );

    const stats: SessionStats = {
      timestamp: Date.now(),
      agentCount: agents.length,
      mainAgentTurns: mainAgent?.turnCount ?? 0,
      maxObservedInputTokens,
      totalOutputTokens: agents.reduce(
        (sum, agent) => sum + agent.totalOutputTokens,
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
    return this.registry.getAgents();
  }

  createDiagnosticDump(vscodeSessionId: string): DiagnosticDump {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const diagnostics = this.registry.getDiagnosticsSnapshotData();
    const tree = TreeDiagnostics.createSnapshot(
      new Map(diagnostics.agents),
      Array.from(diagnostics.claims),
      diagnostics.mainAgentId,
      diagnostics.activeAgentId,
    );
    const invariants = treeDiagnostics.checkInvariants(tree);
    const treeText = treeDiagnostics.createTreeText(tree);
    const pendingClaims = diagnostics.claims.map((claim) => ({
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

  dispose(): void {
    this.clearHideTimeout();
    if (this.registrySubscription) {
      this.registrySubscription.dispose();
      this.registrySubscription = null;
    }
    this.statusBarItem.dispose();
  }
}
