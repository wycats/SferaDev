/**
 * Agent Tree View
 *
 * Provides a VS Code TreeView showing the agent hierarchy with token usage.
 * Displays main agent and subagents with their status and token counts.
 */

import * as vscode from "vscode";
import type { AgentEntry, TokenStatusBar } from "./status-bar.js";
import type { SessionStats } from "./persistence/index.js";
import { formatTokens, getDisplayTokens } from "./tokens/display.js";

/**
 * Union type for all tree items in the agent tree
 */
export type TreeItem = AgentTreeItem | LastSessionTreeItem;

/**
 * Tree item representing an agent in the hierarchy
 */
export class AgentTreeItem extends vscode.TreeItem {
  public readonly agent: AgentEntry;

  constructor(
    agent: AgentEntry,
    collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    super(agent.name, collapsibleState);
    this.agent = agent;

    this.id = agent.id;
    this.contextValue = agent.isMain ? "mainAgent" : "subAgent";

    // Set description (shown after label)
    this.description = this.formatDescription();

    // Set tooltip with full details
    this.tooltip = this.formatTooltip();

    // Set icon based on status
    this.iconPath = this.getIcon();
  }

  private formatDescription(): string {
    const parts: string[] = [];

    // Compute the token value we'll display AND use for percentage
    // INVARIANT: displayedTokens is used for both display and percentage calculation
    let displayedTokens: number | null = null;

    const display = getDisplayTokens(this.agent);
    if (this.agent.status === "error") {
      parts.push("error");
    } else if (display) {
      displayedTokens = display.value;
      const prefix = display.isEstimate ? "~" : "";
      parts.push(`${prefix}${formatTokens(displayedTokens)}`);
    } else {
      parts.push("streaming...");
    }

    // Percentage uses the SAME value as display (invariant)
    if (this.agent.maxInputTokens && displayedTokens) {
      const pct = Math.round(
        (displayedTokens / this.agent.maxInputTokens) * 100,
      );
      parts.push(`(${pct}%)`);
    }

    return parts.join(" ");
  }

  private formatTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    md.appendMarkdown(
      `### ${this.agent.isMain ? "Main Agent" : "Subagent"}: ${this.agent.name}\n\n`,
    );

    md.appendMarkdown(`**Status:** ${this.agent.status}\n\n`);

    if (this.agent.modelId) {
      md.appendMarkdown(`**Model:** ${this.agent.modelId}\n\n`);
    }

    if (this.agent.status === "streaming") {
      const display = getDisplayTokens(this.agent);
      if (display) {
        const label = display.isEstimate ? "Estimated Input" : "Input";
        md.appendMarkdown(
          `**${label}:** ${display.value.toLocaleString()} tokens\n\n`,
        );
      }
    } else {
      // Show accumulated totals for multi-turn conversations
      if (this.agent.turnCount > 1) {
        md.appendMarkdown(`**Turns:** ${this.agent.turnCount}\n\n`);
        md.appendMarkdown(
          `**Input:** ${this.agent.lastActualInputTokens.toLocaleString()}\n\n`,
        );
        md.appendMarkdown(
          `**Total Output:** ${this.agent.totalOutputTokens.toLocaleString()}\n\n`,
        );
        md.appendMarkdown(
          `**Last Turn:** ${this.agent.inputTokens.toLocaleString()} in, ${this.agent.outputTokens.toLocaleString()} out\n\n`,
        );
      } else {
        md.appendMarkdown(
          `**Input Tokens:** ${this.agent.inputTokens.toLocaleString()}\n\n`,
        );
        md.appendMarkdown(
          `**Output Tokens:** ${this.agent.outputTokens.toLocaleString()}\n\n`,
        );
      }
    }

    if (this.agent.maxInputTokens) {
      md.appendMarkdown(
        `**Max Input:** ${this.agent.maxInputTokens.toLocaleString()}\n\n`,
      );
    }

    // Context management info (server-side compaction)
    if (this.agent.contextManagement?.appliedEdits.length) {
      const edits = this.agent.contextManagement.appliedEdits;
      const freedTokens = edits.reduce(
        (sum, e) => sum + e.clearedInputTokens,
        0,
      );
      md.appendMarkdown(
        `**Context Compaction:** ${edits.length} edit(s), freed ${freedTokens.toLocaleString()} tokens\n\n`,
      );
    }

    // Summarization compaction (VS Code client-side)
    if (this.agent.summarizationDetected && this.agent.summarizationReduction) {
      md.appendMarkdown(
        `**Summarized:** Context reduced by ${this.agent.summarizationReduction.toLocaleString()} tokens\n\n`,
      );
    }

    // Timing info
    const elapsed = Date.now() - this.agent.startTime;
    md.appendMarkdown(`**Duration:** ${this.formatDuration(elapsed)}\n\n`);

    if (this.agent.dimmed) {
      md.appendMarkdown(`*Dimmed (older request)*\n\n`);
    }

    return md;
  }

  private getIcon(): vscode.ThemeIcon {
    switch (this.agent.status) {
      case "streaming":
        return new vscode.ThemeIcon(
          "loading~spin",
          new vscode.ThemeColor("charts.yellow"),
        );
      case "error":
        return new vscode.ThemeIcon(
          "error",
          new vscode.ThemeColor("errorForeground"),
        );
      case "complete": {
        // Show fold icon if context was compacted (server or summarization)
        const hasCompaction =
          (this.agent.contextManagement?.appliedEdits.length ?? 0) > 0 ||
          this.agent.summarizationDetected === true;
        const iconName = hasCompaction ? "fold" : "check";

        // Check context utilization for color
        const display = getDisplayTokens(this.agent);
        const inputTokens = display?.value ?? 0;
        if (this.agent.maxInputTokens && inputTokens) {
          const pct = inputTokens / this.agent.maxInputTokens;
          if (pct > 0.9) {
            return new vscode.ThemeIcon(
              iconName,
              new vscode.ThemeColor("charts.red"),
            );
          }
          if (pct > 0.7) {
            return new vscode.ThemeIcon(
              iconName,
              new vscode.ThemeColor("charts.orange"),
            );
          }
        }
        return new vscode.ThemeIcon(
          iconName,
          new vscode.ThemeColor("charts.green"),
        );
      }
    }
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    }
    if (ms < 60000) {
      return `${(ms / 1000).toFixed(1)}s`;
    }
    const mins = Math.floor(ms / 60000);
    const secs = Math.round((ms % 60000) / 1000);
    return `${mins}m ${secs}s`;
  }
}

/**
 * Tree item showing last session stats when no active agents
 */
class LastSessionTreeItem extends vscode.TreeItem {
  constructor(stats: SessionStats) {
    super("Last Session", vscode.TreeItemCollapsibleState.None);

    const tokens = formatTokens(stats.maxObservedInputTokens);

    this.description = `${stats.agentCount} agent${stats.agentCount !== 1 ? "s" : ""}, ${tokens} context tokens`;
    this.tooltip = this.formatTooltip(stats);
    this.iconPath = new vscode.ThemeIcon(
      "history",
      new vscode.ThemeColor("descriptionForeground"),
    );
    this.contextValue = "lastSession";
  }

  private formatTooltip(stats: SessionStats): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`### Last Session\n\n`);
    md.appendMarkdown(`**Agents:** ${stats.agentCount}\n\n`);
    md.appendMarkdown(`**Main Agent Turns:** ${stats.mainAgentTurns}\n\n`);
    md.appendMarkdown(
      `**Max Context:** ${stats.maxObservedInputTokens.toLocaleString()} tokens\n\n`,
    );
    md.appendMarkdown(
      `**Total Output:** ${stats.totalOutputTokens.toLocaleString()} tokens\n\n`,
    );
    if (stats.modelId) {
      md.appendMarkdown(`**Model:** ${stats.modelId}\n\n`);
    }
    const date = new Date(stats.timestamp);
    md.appendMarkdown(`*${date.toLocaleString()}*`);
    return md;
  }
}

/**
 * Tree data provider for the agent hierarchy
 */
export class AgentTreeDataProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    TreeItem | undefined | null
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private statusBar: TokenStatusBar | null = null;
  private disposables: vscode.Disposable[] = [];

  /**
   * Connect to a TokenStatusBar to receive agent updates
   */
  setStatusBar(statusBar: TokenStatusBar): void {
    // Clean up previous subscription
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];

    this.statusBar = statusBar;

    // Subscribe to agent changes
    this.disposables.push(
      statusBar.onDidChangeAgents(() => {
        this._onDidChangeTreeData.fire(undefined);
      }),
    );

    // Initial refresh
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItem): TreeItem[] {
    if (!this.statusBar) {
      return [];
    }

    const allAgents = this.statusBar.getAgents();

    // When idle (no active streaming), filter to only the most recent
    // conversation's agents. This prevents showing a composite of agents
    // from all past conversations. Applied to both root and child lookups.
    const isIdle = this.statusBar.getActiveAgentId() === null;
    const lastConversationId =
      this.statusBar.getLastActiveConversationId();

    const agents =
      isIdle && lastConversationId
        ? allAgents.filter(
            (a) =>
              a.conversationId === lastConversationId ||
              a.parentConversationHash === lastConversationId,
          )
        : allAgents;

    if (!element) {
      if (agents.length === 0) {
        // Show last session stats if available
        const lastSession = this.statusBar.getLastSessionStats();
        if (lastSession) {
          return [new LastSessionTreeItem(lastSession)];
        }
        return [];
      }

      // Build set of valid parent identifiers (conversationId or agentTypeHash)
      const parentIdentifiers = new Set<string>();
      for (const agent of agents) {
        if (agent.conversationId) {
          parentIdentifiers.add(agent.conversationId);
        }
        if (agent.agentTypeHash) {
          parentIdentifiers.add(agent.agentTypeHash);
        }
      }

      // Root level: agents with no parent conversation OR orphaned agents
      // (agents whose parentConversationHash doesn't match any existing agent)
      const rootAgents = agents.filter(
        (a) =>
          !a.parentConversationHash ||
          !parentIdentifiers.has(a.parentConversationHash),
      );

      // Sort by start time (most recent first)
      const sortByTime = (a: AgentEntry, b: AgentEntry) =>
        b.startTime - a.startTime;

      return rootAgents
        .sort(sortByTime)
        .map(
          (agent) =>
            new AgentTreeItem(
              agent,
              this.hasChildren(agent, agents)
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.None,
            ),
        );
    }

    // LastSessionTreeItem has no children
    if (!(element instanceof AgentTreeItem)) {
      return [];
    }

    // Get children of this element (use filtered agents to prevent cross-conversation leaks)
    const childAgents = this.getChildAgents(element.agent, agents);

    // Sort by start time (most recent first)
    childAgents.sort((a, b) => b.startTime - a.startTime);

    return childAgents.map(
      (agent) => new AgentTreeItem(agent, vscode.TreeItemCollapsibleState.None),
    );
  }

  /**
   * Check if an agent has any children (linked via conversationId or agentTypeHash)
   */
  private hasChildren(agent: AgentEntry, allAgents: AgentEntry[]): boolean {
    // Check for children linked via stable conversationId (preferred)
    if (agent.conversationId) {
      if (
        allAgents.some(
          (a) =>
            a.parentConversationHash === agent.conversationId &&
            a.id !== agent.id,
        )
      ) {
        return true;
      }
    }
    // Check for children linked via agentTypeHash
    // (fallback when conversationId is not yet available)
    if (agent.agentTypeHash) {
      if (
        allAgents.some(
          (a) =>
            a.parentConversationHash === agent.agentTypeHash &&
            a.id !== agent.id,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get child agents linked to a parent (via conversationId or agentTypeHash)
   */
  private getChildAgents(
    parent: AgentEntry,
    allAgents: AgentEntry[],
  ): AgentEntry[] {
    const children: AgentEntry[] = [];
    const seenIds = new Set<string>();

    // Children linked via stable conversationId (preferred)
    if (parent.conversationId) {
      for (const agent of allAgents) {
        if (
          agent.parentConversationHash === parent.conversationId &&
          !seenIds.has(agent.id) &&
          agent.id !== parent.id
        ) {
          children.push(agent);
          seenIds.add(agent.id);
        }
      }
    }

    // Children linked via agentTypeHash
    // (fallback when conversationId is not yet available)
    if (parent.agentTypeHash) {
      for (const agent of allAgents) {
        if (
          agent.parentConversationHash === parent.agentTypeHash &&
          !seenIds.has(agent.id) &&
          agent.id !== parent.id
        ) {
          children.push(agent);
          seenIds.add(agent.id);
        }
      }
    }

    return children;
  }

  /**
   * Get parent for tree navigation
   */
  getParent(_element: AgentTreeItem): AgentTreeItem | null | undefined {
    // Flat structure for now
    return null;
  }

  /**
   * Refresh the tree view
   */
  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeTreeData.dispose();
  }
}

/**
 * Create and register the agent tree view
 */
export function createAgentTreeView(statusBar: TokenStatusBar): {
  treeView: vscode.TreeView<TreeItem>;
  provider: AgentTreeDataProvider;
} {
  const provider = new AgentTreeDataProvider();
  provider.setStatusBar(statusBar);

  const treeView = vscode.window.createTreeView("vercel.ai.agentTree", {
    treeDataProvider: provider,
    showCollapseAll: false,
  });

  return { treeView, provider };
}
