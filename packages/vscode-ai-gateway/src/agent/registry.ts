/**
 * AgentRegistry - Core interface for agent lifecycle management
 *
 * This interface defines the contract for tracking agent state across
 * the extension. It separates registry concerns (state, identity, events)
 * from UI concerns (status bar display).
 *
 * Key responsibilities:
 * - Agent lifecycle (start, complete, error)
 * - Identity resolution (conversationId, agentTypeHash)
 * - Parent-child linking (claims, subagent resolution)
 * - Event emission for observers (tree view, diagnostics)
 */

import type * as vscode from "vscode";
import type { PendingChildClaim } from "../identity/claim-registry.js";
import type { AgentEntry, TokenUsage } from "./types.js";

/**
 * Event emitted when the agent registry changes.
 *
 * Discriminated union allows subscribers to handle specific event types
 * and access event-specific data (e.g., chatId for causedByChatId tracking).
 */
export type AgentRegistryEvent =
  | AgentStartedEvent
  | AgentCompletedEvent
  | AgentErroredEvent
  | AgentsClearedEvent
  | AgentUpdatedEvent
  | AgentRemovedEvent;

/**
 * Base fields shared by all registry events.
 * Provides identity context for causality tracking in InvestigationLogger.
 */
export interface AgentRegistryEventBase {
  /** Monotonically increasing sequence number for deterministic ordering */
  sequence: number;
  /** Timestamp of the event */
  timestamp: number;
}

export interface AgentRegistryDiagnosticsState {
  agents: ReadonlyMap<string, AgentEntry>;
  claims: readonly PendingChildClaim[];
  mainAgentId: string | null;
  activeAgentId: string | null;
}

export interface AgentStartedEvent extends AgentRegistryEventBase {
  type: "agent-started";
  /** The agent ID (request ID from VS Code) */
  agentId: string;
  /** The canonical agent ID (may differ if aliased) */
  canonicalAgentId: string;
  /** VS Code chat ID (for causedByChatId tracking in InvestigationLogger) */
  chatId: string | undefined;
  /** Parent chat ID if this is a subagent */
  parentChatId: string | undefined;
  /** Stable conversation UUID from stateful marker */
  conversationId: string | undefined;
  /** Agent type hash for identity matching */
  agentTypeHash: string | undefined;
  /** Whether this is the main agent */
  isMain: boolean;
  /** Whether this is a new conversation or a resumed one */
  isResume: boolean;
  /** Parent conversation hash if this is a subagent */
  parentConversationHash: string | null | undefined;
}

export interface AgentCompletedEvent extends AgentRegistryEventBase {
  type: "agent-completed";
  /** The agent ID (request ID from VS Code) */
  agentId: string;
  /** The canonical agent ID (may differ if aliased) */
  canonicalAgentId: string;
  /** VS Code chat ID (for causedByChatId tracking in InvestigationLogger) */
  chatId: string | undefined;
  /** Stable conversation UUID from stateful marker */
  conversationId: string | undefined;
  /** Token usage from the completed request */
  usage: TokenUsage;
  /** Current turn count after completion */
  turnCount: number;
  /** Whether summarization was detected */
  summarizationDetected: boolean;
}

export interface AgentErroredEvent extends AgentRegistryEventBase {
  type: "agent-errored";
  /** The agent ID (request ID from VS Code) */
  agentId: string;
  /** The canonical agent ID (may differ if aliased) */
  canonicalAgentId: string;
  /** VS Code chat ID (for causedByChatId tracking in InvestigationLogger) */
  chatId: string | undefined;
  /** Stable conversation UUID from stateful marker */
  conversationId: string | undefined;
}

export interface AgentsClearedEvent extends AgentRegistryEventBase {
  type: "agents-cleared";
}

export interface AgentUpdatedEvent extends AgentRegistryEventBase {
  type: "agent-updated";
  /** The agent ID that was updated */
  agentId: string;
  /** The canonical agent ID */
  canonicalAgentId: string;
  /** VS Code chat ID (for causedByChatId tracking in InvestigationLogger) */
  chatId: string | undefined;
  /** Stable conversation UUID */
  conversationId: string | undefined;
  /** What was updated */
  updateType:
    | "turn-count-sync"
    | "title-generated"
    | "child-linked"
    | "main-demoted";
}

export interface AgentRemovedEvent extends AgentRegistryEventBase {
  type: "agent-removed";
  /** The agent ID that was removed */
  agentId: string;
  /** VS Code chat ID (for causedByChatId tracking in InvestigationLogger) */
  chatId: string | undefined;
  /** Stable conversation UUID */
  conversationId: string | undefined;
  /** Reason for removal */
  reason: "aged" | "cleared";
}

/**
 * Context from a previous turn, used for delta token estimation.
 */
export interface AgentContext {
  /** Actual input tokens from the last completed turn */
  lastActualInputTokens: number;
  /** Number of messages in the last completed request */
  lastMessageCount: number;
}

/**
 * Parameters for starting a new agent.
 */
export interface StartAgentParams {
  agentId: string;
  /** VS Code chat ID (for causedByChatId tracking in InvestigationLogger) */
  chatId?: string;
  /** Parent chat ID if this is a subagent */
  parentChatId?: string;
  estimatedTokens?: number;
  maxTokens?: number;
  modelId?: string;
  systemPromptHash?: string;
  agentTypeHash?: string;
  firstUserMessageHash?: string;
  estimatedDeltaTokens?: number;
  conversationId?: string;
  isSummarization?: boolean;
  firstUserMessagePreview?: string;
}

/**
 * Core interface for agent registry operations.
 *
 * Implementations must:
 * - Emit events for all state changes
 * - Maintain consistent identity resolution
 * - Support parent-child linking via claims
 */
export interface AgentRegistry {
  /**
   * Event fired when agents change.
   * Subscribers receive detailed event data for logging/diagnostics.
   */
  readonly onDidChangeAgents: vscode.Event<AgentRegistryEvent>;

  /**
   * Start tracking a new agent or resume an existing conversation.
   *
   * @returns The canonical agent ID (may differ from input if conversation resumed)
   */
  startAgent(params: StartAgentParams): string;

  /**
   * Mark an agent as completed with token usage data.
   */
  completeAgent(agentId: string, usage: TokenUsage): void;

  /**
   * Mark an agent as errored.
   */
  errorAgent(agentId: string): void;

  /**
   * Get all tracked agents.
   */
  getAgents(): AgentEntry[];

  /**
   * Get the current turn count for an agent.
   * Used to capture turn number for characterization callbacks.
   */
  getAgentTurnCount(agentId: string): number;

  /**
   * Get context from a previous turn for delta estimation.
   * Returns undefined if no previous turn exists.
   */
  getAgentContext(conversationId: string): AgentContext | undefined;

  /**
   * Update an agent's activity timestamp during streaming.
   */
  updateAgentActivity(agentId: string): void;

  /**
   * Synchronize an agent's turn count with external source (activity log).
   * Called when the activity log detects the agent's turnCount is behind.
   */
  syncAgentTurnCount(conversationId: string, turnCount: number): void;

  /**
   * Create a claim for an expected child agent.
   * Called when parent agent invokes runSubagent tool.
   */
  createChildClaim(parentAgentId: string, expectedChildAgentName: string): void;

  /**
   * Update an agent's generated title.
   * Called when TitleGenerator or TurnCharacterizer produces a title.
   * Emits AgentUpdatedEvent with updateType: 'title-generated'.
   */
  updateAgentTitle(conversationId: string, title: string): void;

  /**
   * Link a child agent to its parent.
   * Called when a subagent is resolved to its parent.
   * Emits AgentUpdatedEvent with updateType: 'child-linked'.
   */
  linkChildAgent(
    parentConversationId: string,
    childConversationId: string,
  ): void;

  /**
   * Snapshot data for diagnostics and status bar displays.
   */
  getDiagnosticsSnapshotData(): AgentRegistryDiagnosticsState;

  /**
   * Clear all agents (e.g., on extension deactivation).
   */
  clearAgents(): void;
}
