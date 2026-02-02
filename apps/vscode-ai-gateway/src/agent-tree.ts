/**
 * Agent Tree View
 *
 * Provides a VS Code TreeView showing the agent hierarchy with token usage.
 * Displays main agent and subagents with their status and token counts.
 */

import * as vscode from "vscode";
import type { AgentEntry, TokenStatusBar } from "./status-bar.js";
import type { SessionStats } from "./persistence/index.js";

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

    // Use accumulated totals for multi-turn conversations
    const inputTokens =
      this.agent.turnCount > 1
        ? this.agent.totalInputTokens
        : this.agent.inputTokens;
    const outputTokens =
      this.agent.turnCount > 1
        ? this.agent.totalOutputTokens
        : this.agent.outputTokens;

    if (this.agent.status === "streaming") {
      if (this.agent.estimatedInputTokens) {
        parts.push(`~${this.formatTokens(this.agent.estimatedInputTokens)}`);
      } else {
        parts.push("streaming...");
      }
    } else if (this.agent.status === "complete") {
      // Show turn count for multi-turn conversations
      if (this.agent.turnCount > 1) {
        parts.push(`[${this.agent.turnCount}]`);
      }
      parts.push(this.formatTokens(inputTokens));
      if (outputTokens > 0) {
        parts.push(`→${this.formatTokens(outputTokens)}`);
      }
    } else {
      // status === "error"
      parts.push("error");
    }

    if (this.agent.maxInputTokens) {
      const tokensForPct =
        inputTokens || (this.agent.estimatedInputTokens ?? 0);
      const pct = Math.round((tokensForPct / this.agent.maxInputTokens) * 100);
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
      if (this.agent.estimatedInputTokens) {
        md.appendMarkdown(
          `**Estimated Input:** ${this.agent.estimatedInputTokens.toLocaleString()} tokens\n\n`,
        );
      }
    } else {
      // Show accumulated totals for multi-turn conversations
      if (this.agent.turnCount > 1) {
        md.appendMarkdown(`**Turns:** ${this.agent.turnCount}\n\n`);
        md.appendMarkdown(
          `**Total Input:** ${this.agent.totalInputTokens.toLocaleString()}\n\n`,
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

    // Context management info
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
        // Check context utilization for color
        if (this.agent.maxInputTokens && this.agent.inputTokens) {
          const pct = this.agent.inputTokens / this.agent.maxInputTokens;
          if (pct > 0.9) {
            return new vscode.ThemeIcon(
              "check",
              new vscode.ThemeColor("charts.red"),
            );
          }
          if (pct > 0.7) {
            return new vscode.ThemeIcon(
              "check",
              new vscode.ThemeColor("charts.orange"),
            );
          }
        }
        return new vscode.ThemeIcon(
          "check",
          new vscode.ThemeColor("charts.green"),
        );
      }
    }
  }

  private formatTokens(count: number): string {
    if (count >= 1000000) {
      return `${(count / 1000000).toFixed(1)}M`;
    }
    if (count >= 1000) {
      return `${(count / 1000).toFixed(1)}k`;
    }
    return count.toString();
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

    const tokens =
      stats.totalInputTokens >= 1000
        ? `${(stats.totalInputTokens / 1000).toFixed(1)}k`
        : stats.totalInputTokens.toString();

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
      `**Max Context:** ${stats.totalInputTokens.toLocaleString()} tokens\n\n`,
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

    const agents = this.statusBar.getAgents();

    if (!element) {
      if (agents.length === 0) {
        // Show last session stats if available
        const lastSession = this.statusBar.getLastSessionStats();
        if (lastSession) {
          return [new LastSessionTreeItem(lastSession)];
        }
        return [];
      }

      // Root level: agents with no parent conversation
      const rootAgents = agents.filter((a) => !a.parentConversationHash);

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

    // Get children of this element
    // Check both conversationHash (final) and agentTypeHash (provisional)
    const childAgents = this.getChildAgents(element.agent, agents);

    // Sort by start time (most recent first)
    childAgents.sort((a, b) => b.startTime - a.startTime);

    return childAgents.map(
      (agent) => new AgentTreeItem(agent, vscode.TreeItemCollapsibleState.None),
    );
  }

  /**
   * Check if an agent has any children (linked via conversationHash or agentTypeHash)
   */
  private hasChildren(agent: AgentEntry, allAgents: AgentEntry[]): boolean {
    // Check for children linked via final conversationHash
    if (agent.conversationHash) {
      if (
        allAgents.some(
          (a) => a.parentConversationHash === agent.conversationHash,
        )
      ) {
        return true;
      }
    }
    // Check for children linked via provisional agentTypeHash
    // (before parent has computed its conversationHash)
    if (agent.agentTypeHash) {
      if (
        allAgents.some((a) => a.parentConversationHash === agent.agentTypeHash)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get child agents linked to a parent (via conversationHash or agentTypeHash)
   */
  private getChildAgents(
    parent: AgentEntry,
    allAgents: AgentEntry[],
  ): AgentEntry[] {
    const children: AgentEntry[] = [];
    const seenIds = new Set<string>();

    // Children linked via final conversationHash
    if (parent.conversationHash) {
      for (const agent of allAgents) {
        if (
          agent.parentConversationHash === parent.conversationHash &&
          !seenIds.has(agent.id)
        ) {
          children.push(agent);
          seenIds.add(agent.id);
        }
      }
    }

    // Children linked via provisional agentTypeHash
    // (before parent has computed its conversationHash)
    if (parent.agentTypeHash) {
      for (const agent of allAgents) {
        if (
          agent.parentConversationHash === parent.agentTypeHash &&
          !seenIds.has(agent.id)
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

  const treeView = vscode.window.createTreeView("vercelAiGateway.agentTree", {
    treeDataProvider: provider,
    showCollapseAll: false,
  });

  return { treeView, provider };
}
