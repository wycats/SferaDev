import * as vscode from "vscode";
import type {
  AgentEntry,
  ContextManagementEdit,
  TokenStatusBar,
} from "../status-bar.js";
import type { Conversation, Subagent } from "./types.js";

/** 5 minutes idle threshold per RFC 00073 */
const RECENT_ACTIVITY_WINDOW_MS = 5 * 60 * 1000;

type CompactionTotals = {
  /** Cumulative summarization tokens freed (from agent.summarizationReduction) */
  summarization: number;
  /** Our tracked cumulative context management tokens (since API is per-turn) */
  contextCumulative: number;
  /** Last seen context management total from current turn (to detect new edits) */
  lastContextTurnTotal: number;
};

/**
 * Builds conversation snapshots from status bar agent state.
 */
export class ConversationManager implements vscode.Disposable {
  private conversations = new Map<string, Conversation>();
  private previousCompactionState = new Map<string, CompactionTotals>();
  private disposables: vscode.Disposable[] = [];

  private readonly _onDidChangeConversations = new vscode.EventEmitter<void>();
  readonly onDidChangeConversations = this._onDidChangeConversations.event;

  constructor(private statusBar: TokenStatusBar) {
    this.disposables.push(statusBar.onDidChangeAgents(() => this.rebuild()));

    this.rebuild();
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

  private rebuild(): void {
    const agents = this.statusBar.getAgents();

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
        subagents: [],
        ...this.getWorkspaceFolderProp(),
      };

      conversation.subagents = this.buildSubagentHierarchy(
        root,
        agents,
        new Set([conversationId]),
      );

      this.detectCompactionEvents(root, conversation);

      nextConversations.set(conversationId, conversation);
    }

    this.conversations = nextConversations;
    this.pruneCompactionState();
    this._onDidChangeConversations.fire();
  }

  private pruneCompactionState(): void {
    for (const conversationId of this.previousCompactionState.keys()) {
      if (!this.conversations.has(conversationId)) {
        this.previousCompactionState.delete(conversationId);
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
