/**
 * Agent Tree View
 *
 * Provides a VS Code TreeView showing the agent hierarchy with token usage.
 * Displays main agent and subagents with their status and token counts.
 */

import * as vscode from "vscode";
import type { AgentEntry, TokenStatusBar } from "./status-bar.js";

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

    if (this.agent.status === "streaming") {
      if (this.agent.estimatedInputTokens) {
        parts.push(`~${this.formatTokens(this.agent.estimatedInputTokens)}`);
      } else {
        parts.push("streaming...");
      }
    } else if (this.agent.status === "complete") {
      parts.push(this.formatTokens(this.agent.inputTokens));
      if (this.agent.outputTokens > 0) {
        parts.push(`→${this.formatTokens(this.agent.outputTokens)}`);
      }
    } else {
      // status === "error"
      parts.push("error");
    }

    if (this.agent.maxInputTokens) {
      const pct = Math.round(
        ((this.agent.inputTokens || (this.agent.estimatedInputTokens ?? 0)) /
          this.agent.maxInputTokens) *
          100,
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
      if (this.agent.estimatedInputTokens) {
        md.appendMarkdown(
          `**Estimated Input:** ${this.agent.estimatedInputTokens.toLocaleString()} tokens\n\n`,
        );
      }
    } else {
      md.appendMarkdown(
        `**Input Tokens:** ${this.agent.inputTokens.toLocaleString()}\n\n`,
      );
      md.appendMarkdown(
        `**Output Tokens:** ${this.agent.outputTokens.toLocaleString()}\n\n`,
      );
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
 * Tree data provider for the agent hierarchy
 */
export class AgentTreeDataProvider implements vscode.TreeDataProvider<AgentTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    AgentTreeItem | undefined | null
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

  getTreeItem(element: AgentTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: AgentTreeItem): AgentTreeItem[] {
    if (!this.statusBar) {
      return [];
    }

    const agents = this.statusBar.getAgents();

    if (!element) {
      // Root level: show main agents first, then subagents
      const mainAgents = agents.filter((a) => a.isMain);
      const subAgents = agents.filter((a) => !a.isMain);

      // Sort by start time (most recent first)
      const sortByTime = (a: AgentEntry, b: AgentEntry) =>
        b.startTime - a.startTime;

      const items: AgentTreeItem[] = [];

      // Add main agents (usually just one, but could be multiple in edge cases)
      for (const agent of mainAgents.sort(sortByTime)) {
        items.push(
          new AgentTreeItem(
            agent,
            subAgents.length > 0
              ? vscode.TreeItemCollapsibleState.Expanded
              : vscode.TreeItemCollapsibleState.None,
          ),
        );
      }

      // Add subagents as children of the most recent main agent
      // For now, show them at root level with indentation via tree structure
      for (const agent of subAgents.sort(sortByTime)) {
        items.push(
          new AgentTreeItem(agent, vscode.TreeItemCollapsibleState.None),
        );
      }

      return items;
    }

    // No nested children for now
    return [];
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
  treeView: vscode.TreeView<AgentTreeItem>;
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
