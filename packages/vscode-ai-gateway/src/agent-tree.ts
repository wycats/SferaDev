/**
 * Conversation-Centric Agent Tree View (RFC 00073)
 *
 * Provides a VS Code TreeView showing conversations as the primary
 * hierarchy, with activity log entries (turns, compaction, errors)
 * as children, and subagents nested under their spawning turns.
 */

import * as vscode from "vscode";
import type { AgentRegistry } from "./agent/index.js";
import {
  ConversationManager,
  ConversationItem,
  AIResponseItem,
  TurnItem,
  CompactionTreeItem,
  ErrorTreeItem,
  SubagentItem,
  HistoryItem,
  SectionHeaderItem,
  ToolContinuationItem,
  UserMessageItem,
} from "./conversation/index.js";
import type { Conversation } from "@vercel/conversation";
import {
  buildTree,
  groupByUserMessage,
  type TreeNode,
  type TreeResult,
} from "@vercel/conversation";

/**
 * Union type for all tree items in the conversation tree
 */
export type TreeItem =
  | ConversationItem
  | UserMessageItem
  | ToolContinuationItem
  | AIResponseItem
  | TurnItem
  | CompactionTreeItem
  | ErrorTreeItem
  | SubagentItem
  | HistoryItem
  | SectionHeaderItem;

/**
 * Tree data provider using ConversationManager as data source.
 *
 * Root: active ConversationItems + SectionHeaderItem (History) if idle/archived exist.
 * ConversationItem children: windowed activity log + HistoryItem.
 * AIResponseItem children: SubagentItems (resolved from response's subagentIds).
 * TurnItem children: SubagentItems (legacy).
 * SubagentItem children: nested SubagentItems.
 * HistoryItem children: older activity log entries.
 * SectionHeaderItem children: idle/archived ConversationItems.
 */
export class ConversationTreeDataProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    TreeItem | undefined | null
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private manager: ConversationManager;
  private disposables: vscode.Disposable[] = [];

  constructor(registry: AgentRegistry) {
    this.manager = new ConversationManager(registry);

    this.disposables.push(
      this.manager.onDidChangeConversations(() => {
        this._onDidChangeTreeData.fire(undefined);
      }),
    );
  }

  /**
   * Get the ConversationManager for external use (e.g., turn characterization).
   */
  getManager(): ConversationManager {
    return this.manager;
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItem): TreeItem[] {
    if (!element) {
      return this.getRootChildren();
    }

    if (element instanceof ConversationItem) {
      return this.getConversationChildren(element);
    }

    if (element instanceof UserMessageItem) {
      return this.getUserMessageChildren(element);
    }

    if (element instanceof TurnItem) {
      return this.getTurnChildren(element);
    }

    if (element instanceof AIResponseItem) {
      return this.getAIResponseChildren(element);
    }

    if (element instanceof SubagentItem) {
      return element.subagent.children.map(
        (child) => new SubagentItem(child, element.conversationId),
      );
    }

    if (element instanceof HistoryItem) {
      const conversation = this.manager
        .getConversations()
        .find((c) => c.id === element.conversationId);
      const nodes = groupByUserMessage(element.entries);
      return treeNodesToItems(nodes, element.conversationId, conversation);
    }

    if (element instanceof SectionHeaderItem) {
      return element.conversations.map((conv) => new ConversationItem(conv));
    }

    return [];
  }

  private getRootChildren(): TreeItem[] {
    const conversations = this.manager.getConversations();

    if (conversations.length === 0) {
      return [];
    }

    const { active, history } =
      SectionHeaderItem.partitionConversations(conversations);

    // Sort active by most recent first
    active.sort((a, b) => b.lastActiveTime - a.lastActiveTime);

    const items: TreeItem[] = active.map((conv) => new ConversationItem(conv));

    if (history.length > 0) {
      // Sort history by most recent first
      history.sort((a, b) => b.lastActiveTime - a.lastActiveTime);
      items.push(new SectionHeaderItem(history));
    }

    return items;
  }

  private getConversationChildren(element: ConversationItem): TreeItem[] {
    const conversation = element.conversation;
    const result = buildTree(conversation.activityLog);

    return treeResultToItems(result, conversation.id, conversation);
  }

  private getTurnChildren(element: TurnItem): TreeItem[] {
    const conversation = this.manager
      .getConversations()
      .find((c) => c.id === element.conversationId);

    if (!conversation) {
      return [];
    }

    const subagents = SubagentItem.resolveSubagents(
      element.turn.subagentIds,
      conversation.subagents,
    );

    return subagents.map(
      (sub) => new SubagentItem(sub, element.conversationId),
    );
  }

  private getAIResponseChildren(element: AIResponseItem): TreeItem[] {
    const conversation = this.manager
      .getConversations()
      .find((c) => c.id === element.conversationId);

    if (!conversation) {
      return [];
    }

    const subagents = SubagentItem.resolveSubagents(
      element.entry.subagentIds,
      conversation.subagents,
    );

    return subagents.map(
      (sub) => new SubagentItem(sub, element.conversationId),
    );
  }

  /**
   * Get children for a UserMessageItem (AI responses with same sequenceNumber).
   */
  private getUserMessageChildren(element: UserMessageItem): TreeItem[] {
    const conversation = this.manager
      .getConversations()
      .find((c) => c.id === element.conversationId);

    if (!conversation) {
      return [];
    }

    // Return tree items for each child (AI responses and tool continuations)
    return element.children.map((child) => {
      if (child.type === "ai-response") {
        const subagents = SubagentItem.resolveSubagents(
          child.entry.subagentIds,
          conversation.subagents,
        );
        return new AIResponseItem(
          child.entry,
          element.conversationId,
          subagents,
        );
      } else if (child.type === "error") {
        return new ErrorTreeItem(child.entry, element.conversationId);
      } else {
        // tool-continuation
        return new ToolContinuationItem(
          child.entry,
          element.conversationId,
          child.tools,
        );
      }
    });
  }

  /**
   * Refresh the tree view.
   */
  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  dispose(): void {
    this.manager.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeTreeData.dispose();
  }
}

// Re-export for backward compatibility
export {
  ConversationItem,
  TurnItem,
  SubagentItem,
  UserMessageItem,
  AIResponseItem,
};

// ── Pure Tree → VS Code TreeItem Mapping ─────────────────────────────

/**
 * Map a full TreeResult (from buildTree) to VS Code TreeItems.
 * This is the thin presentation layer — all logic lives in build-tree.ts.
 */
function treeResultToItems(
  result: TreeResult,
  conversationId: string,
  conversation?: Conversation,
): TreeItem[] {
  const items = treeNodesToItems(result.topLevel, conversationId, conversation);

  // The history node in the pure tree becomes a HistoryItem
  // (buildTree already appends it to topLevel, but it uses a plain { kind: "history", count }
  //  — we need to replace it with a real HistoryItem that holds the entries for expansion)
  for (let i = 0; i < items.length; i++) {
    const node = result.topLevel[i];
    if (node?.kind === "history") {
      items[i] = new HistoryItem(result.historyEntries, conversationId);
    }
  }

  return items;
}

/**
 * Map an array of TreeNodes to VS Code TreeItems.
 * Used for both the main window and history expansion.
 */
function treeNodesToItems(
  nodes: TreeNode[],
  conversationId: string,
  conversation?: Conversation,
): TreeItem[] {
  return nodes.map((node) =>
    treeNodeToItem(node, conversationId, conversation),
  );
}

/**
 * Map a single TreeNode to a VS Code TreeItem.
 */
function treeNodeToItem(
  node: TreeNode,
  conversationId: string,
  _conversation?: Conversation,
): TreeItem {
  switch (node.kind) {
    case "user-message": {
      // Map TreeChild[] to UserMessageChild[] for the UserMessageItem constructor
      const children = node.children.map((child) => {
        if (child.kind === "ai-response") {
          return { type: "ai-response" as const, entry: child.entry };
        } else if (child.kind === "error") {
          return { type: "error" as const, entry: child.entry };
        } else {
          return {
            type: "tool-continuation" as const,
            entry: child.entry,
            tools: child.tools,
          };
        }
      });
      return new UserMessageItem(
        node.entry,
        conversationId,
        children,
        node.hasError,
      );
    }
    case "compaction":
      return new CompactionTreeItem(node.entry, conversationId);
    case "error":
      return new ErrorTreeItem(node.entry, conversationId);
    case "history":
      // Placeholder — caller replaces with real HistoryItem that has entries
      return new HistoryItem([], conversationId);
  }
}

/**
 * Create and register the agent tree view.
 */
export function createAgentTreeView(registry: AgentRegistry): {
  treeView: vscode.TreeView<TreeItem>;
  provider: ConversationTreeDataProvider;
} {
  const provider = new ConversationTreeDataProvider(registry);

  const treeView = vscode.window.createTreeView("vercel.ai.agentTree", {
    treeDataProvider: provider,
    showCollapseAll: false,
  });

  return { treeView, provider };
}
