/**
 * Tree Diagnostics - Flight recorder for agent tree debugging
 *
 * Captures every event affecting the agent tree with full decision context
 * and a text snapshot of the tree state after each event.
 *
 * Output: .logs/tree-diagnostics.log (JSON lines with embedded tree snapshot)
 */

import * as fs from "fs";
import * as path from "path";
import type { AgentEntry } from "../status-bar.js";
import { safeJsonStringify } from "../utils/serialize.js";
import type { PendingChildClaim } from "../identity/claim-registry.js";

const LOG_DIR = ".logs";
const LOG_FILE = "tree-diagnostics.log";
const ARCHIVE_DIR = "tree-diagnostics";

export interface TreeSnapshot {
  agents: AgentSnapshotEntry[];
  claims: ClaimSnapshotEntry[];
  mainAgentId: string | null;
  activeAgentId: string | null;
}

export interface AgentSnapshotEntry {
  id: string;
  name: string;
  isMain: boolean;
  status: string;
  systemPromptHash?: string;
  agentTypeHash?: string;
  conversationHash?: string;
  parentConversationHash?: string;
  inputTokens: number;
  outputTokens: number;
  maxObservedInputTokens: number;
  totalOutputTokens: number;
  turnCount: number;
  /** Estimated input tokens (before API response) */
  estimatedInputTokens?: number;
  maxInputTokens?: number | undefined;
}

export interface ClaimSnapshotEntry {
  expectedChildAgentName: string;
  parentConversationHash: string;
  parentAgentTypeHash: string;
  expiresIn: number; // seconds remaining
}

export interface InvariantCheckResult {
  singleMainAgent: boolean;
  mainAgentExists: boolean;
  /**
   * @deprecated Use noUnexpectedOrphans instead. Orphaned subagents are expected
   * when claims expire - they are shown at root level in the tree view.
   */
  allChildrenHaveParent: boolean;
  /**
   * @deprecated Use noUnexpectedOrphans instead. Orphaned subagents are expected
   * when claims expire - they are shown at root level in the tree view.
   */
  noOrphanChildren: boolean;
  /**
   * True if no main agents are orphaned. Orphaned subagents are allowed
   * (expected when claims expire), but orphaned main agents indicate a bug.
   */
  noUnexpectedOrphans: boolean;
  noDuplicateIds: boolean;
  claimsHaveValidParent: boolean;
  noExpiredClaims: boolean;
  violations: string[];
}

export interface DiagnosticDump {
  timestamp: string;
  vscodeSessionId: string;
  tree: TreeSnapshot;
  treeText: string;
  invariants: InvariantCheckResult;
  partialKeyMap: Record<string, string>;
  pendingClaims: Array<{
    expectedName: string;
    parentId: string;
    expiresAt: string;
  }>;
}

export type DiagnosticEventType =
  | "AGENT_STARTED"
  | "AGENT_RESUMED"
  | "AGENT_COMPLETED"
  | "AGENT_ERROR"
  | "CLAIM_CREATED"
  | "CLAIM_MATCHED"
  | "CLAIM_EXPIRED"
  | "CLAIM_NOT_MATCHED";

export interface DiagnosticEvent {
  timestamp: string;
  event: DiagnosticEventType;
  data: Record<string, unknown>;
  tree: TreeSnapshot;
  treeText: string;
  invariants?: InvariantCheckResult;
  context?: {
    vscodeSessionId?: string;
  };
}

/**
 * Tree diagnostics logger.
 * Writes to workspace .logs/tree-diagnostics.log
 */
export class TreeDiagnostics {
  private logPath: string | null = null;
  private enabled = false;

  /**
   * Initialize diagnostics for a workspace.
   * Rotates existing log file to archive.
   */
  initialize(workspaceRoot: string): void {
    const logDir = path.join(workspaceRoot, LOG_DIR);
    const archiveDir = path.join(logDir, ARCHIVE_DIR);

    // Ensure directories exist
    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.mkdirSync(archiveDir, { recursive: true });
    } catch {
      // Directory creation failed - disable diagnostics
      console.error("[TreeDiagnostics] Failed to create log directories");
      return;
    }

    this.logPath = path.join(logDir, LOG_FILE);

    // Rotate existing log if present
    if (fs.existsSync(this.logPath)) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const archivePath = path.join(
        archiveDir,
        `tree-diagnostics-${timestamp}.log`,
      );
      try {
        fs.renameSync(this.logPath, archivePath);
      } catch {
        // Rotation failed - just truncate
        fs.writeFileSync(this.logPath, "");
      }
    }

    this.enabled = true;
    this.log(
      "EXTENSION_ACTIVATED",
      {},
      { agents: [], claims: [], mainAgentId: null, activeAgentId: null },
    );
  }

  /**
   * Log a diagnostic event with tree snapshot.
   */
  log(
    event: DiagnosticEventType | "EXTENSION_ACTIVATED",
    data: Record<string, unknown>,
    tree: TreeSnapshot,
    context?: { vscodeSessionId?: string },
  ): void {
    if (!this.enabled || !this.logPath) return;

    const invariants = this.checkInvariants(tree);

    const entry: DiagnosticEvent = {
      timestamp: new Date().toISOString(),
      event: event as DiagnosticEventType,
      data,
      tree,
      treeText: this.renderTreeText(tree),
      invariants,
      ...(context && { context }),
    };

    try {
      fs.appendFileSync(this.logPath, safeJsonStringify(entry) + "\n");
    } catch {
      // Log write failed - disable to avoid repeated errors
      this.enabled = false;
    }
  }

  /**
   * Render a human-readable tree snapshot.
   */
  private renderTreeText(tree: TreeSnapshot): string {
    const lines: string[] = [];

    // Build parent-child relationships
    const childrenByParent = new Map<string, AgentSnapshotEntry[]>();
    const rootAgents: AgentSnapshotEntry[] = [];

    for (const agent of tree.agents) {
      if (agent.parentConversationHash) {
        const siblings =
          childrenByParent.get(agent.parentConversationHash) ?? [];
        siblings.push(agent);
        childrenByParent.set(agent.parentConversationHash, siblings);
      } else {
        rootAgents.push(agent);
      }
    }

    // Render agents recursively
    const visitedIds = new Set<string>();

    const renderAgent = (
      agent: AgentSnapshotEntry,
      indent: string,
      isLast: boolean,
    ): void => {
      if (visitedIds.has(agent.id)) {
        const prefix = isLast ? "└─" : "├─";
        lines.push(`${indent}${prefix} [CYCLE: ${agent.id.slice(-8)}]`);
        return;
      }
      visitedIds.add(agent.id);

      const prefix = isLast ? "└─" : "├─";
      const marker = agent.isMain ? "[main]" : `[${agent.name}]`;
      const hash = agent.agentTypeHash?.slice(0, 8) ?? "????????";
      const status =
        agent.status === "streaming"
          ? "⏳"
          : agent.status === "complete"
            ? "✓"
            : "✗";
      const tokens = `${(agent.maxObservedInputTokens / 1000).toFixed(1)}k→${(agent.totalOutputTokens / 1000).toFixed(1)}k`;
      const turns = agent.turnCount > 0 ? ` [${agent.turnCount}]` : "";

      lines.push(
        `${indent}${prefix} ${marker} (${hash}) ${status} ${tokens}${turns}`,
      );

      // Render children - check both conversationHash and agentTypeHash
      // since children may be linked via either (agentTypeHash is used provisionally
      // before the parent completes and gets a conversationHash)
      const seenChildIds = new Set<string>();
      const children: AgentSnapshotEntry[] = [];

      if (agent.conversationHash) {
        for (const child of childrenByParent.get(agent.conversationHash) ??
          []) {
          if (!seenChildIds.has(child.id)) {
            children.push(child);
            seenChildIds.add(child.id);
          }
        }
      }
      if (agent.agentTypeHash) {
        for (const child of childrenByParent.get(agent.agentTypeHash) ?? []) {
          if (!seenChildIds.has(child.id)) {
            children.push(child);
            seenChildIds.add(child.id);
          }
        }
      }

      const childIndent = indent + (isLast ? "   " : "│  ");
      children.forEach((child, i) => {
        renderAgent(child, childIndent, i === children.length - 1);
      });
    };

    if (rootAgents.length === 0) {
      lines.push("(no agents)");
    } else {
      rootAgents.forEach((agent, i) => {
        renderAgent(agent, "", i === rootAgents.length - 1);
      });
    }

    // Render claims
    if (tree.claims.length > 0) {
      lines.push("");
      lines.push(`CLAIMS (${tree.claims.length}):`);
      for (const claim of tree.claims) {
        const parent = claim.parentConversationHash.slice(0, 8);
        lines.push(
          `  ⏱ "${claim.expectedChildAgentName}" for ${parent}, expires in ${claim.expiresIn}s`,
        );
      }
    }

    return lines.join("\n");
  }

  createTreeText(tree: TreeSnapshot): string {
    return this.renderTreeText(tree);
  }

  /**
   * Check snapshot-only invariants for the tree state.
   */
  checkInvariants(snapshot: TreeSnapshot): InvariantCheckResult {
    const violations: string[] = [];

    const agentIds = new Set<string>();
    const duplicateIds = new Set<string>();
    const conversationHashes = new Set<string>();
    const agentTypeHashes = new Set<string>();
    let mainCount = 0;

    for (const agent of snapshot.agents) {
      if (agent.isMain) mainCount++;
      if (agentIds.has(agent.id)) {
        duplicateIds.add(agent.id);
      } else {
        agentIds.add(agent.id);
      }
      if (agent.conversationHash) {
        conversationHashes.add(agent.conversationHash);
      }
      if (agent.agentTypeHash) {
        agentTypeHashes.add(agent.agentTypeHash);
      }
    }

    const parentIdentifiers = new Set<string>([
      ...conversationHashes,
      ...agentTypeHashes,
    ]);

    // All agents with parentConversationHash that don't have a matching parent
    const missingParentAgents = snapshot.agents.filter(
      (agent) =>
        agent.parentConversationHash &&
        !parentIdentifiers.has(agent.parentConversationHash),
    );

    // Only main agents with missing parents are unexpected - orphaned subagents
    // are expected when claims expire (they are shown at root level in tree view)
    const unexpectedOrphanAgents = missingParentAgents.filter(
      (agent) => agent.isMain,
    );

    const missingClaimParents = snapshot.claims.filter(
      (claim) =>
        !parentIdentifiers.has(claim.parentConversationHash) &&
        !parentIdentifiers.has(claim.parentAgentTypeHash),
    );

    const expiredClaims = snapshot.claims.filter(
      (claim) => claim.expiresIn <= 0,
    );

    const singleMainAgent = mainCount <= 1;
    const mainAgentExists =
      snapshot.agents.length === 0 ? true : mainCount === 1;
    // Deprecated: kept for backward compatibility
    const allChildrenHaveParent = missingParentAgents.length === 0;
    const noOrphanChildren = missingParentAgents.length === 0;
    // New: only flags orphaned main agents (orphaned subagents are expected)
    const noUnexpectedOrphans = unexpectedOrphanAgents.length === 0;
    const noDuplicateIds = duplicateIds.size === 0;
    const claimsHaveValidParent = missingClaimParents.length === 0;
    const noExpiredClaims = expiredClaims.length === 0;

    if (!singleMainAgent) {
      violations.push(
        `Invariant singleMainAgent failed: ${mainCount} main agents detected.`,
      );
    }

    if (!mainAgentExists) {
      violations.push(
        `Invariant mainAgentExists failed: ${snapshot.agents.length} agents with ${mainCount} main.`,
      );
    }

    // Note: allChildrenHaveParent and noOrphanChildren are deprecated.
    // Orphaned subagents are expected when claims expire - they are shown at root level.
    // We only report violations for orphaned MAIN agents (which should never happen).
    if (!noUnexpectedOrphans) {
      violations.push(
        `Invariant noUnexpectedOrphans failed: ${unexpectedOrphanAgents.length} main agent(s) orphaned.`,
      );
    }

    if (!noDuplicateIds) {
      violations.push(
        `Invariant noDuplicateIds failed: ${Array.from(duplicateIds).join(
          ", ",
        )}.`,
      );
    }

    if (!claimsHaveValidParent) {
      violations.push(
        `Invariant claimsHaveValidParent failed: ${missingClaimParents.length} claims missing parents.`,
      );
    }

    if (!noExpiredClaims) {
      violations.push(
        `Invariant noExpiredClaims failed: ${expiredClaims.length} expired claims.`,
      );
    }

    return {
      singleMainAgent,
      mainAgentExists,
      allChildrenHaveParent,
      noOrphanChildren,
      noUnexpectedOrphans,
      noDuplicateIds,
      claimsHaveValidParent,
      noExpiredClaims,
      violations,
    };
  }

  /**
   * Create a snapshot of the current tree state.
   */
  static createSnapshot(
    agents: Map<string, AgentEntry>,
    claims: PendingChildClaim[],
    mainAgentId: string | null,
    activeAgentId: string | null,
  ): TreeSnapshot {
    const now = Date.now();

    const agentSnapshots: AgentSnapshotEntry[] = [];
    for (const agent of agents.values()) {
      const entry: AgentSnapshotEntry = {
        id: agent.id.slice(-8),
        name: agent.name,
        isMain: agent.isMain,
        status: agent.status,
        inputTokens: agent.inputTokens,
        outputTokens: agent.outputTokens,
        maxObservedInputTokens: agent.maxObservedInputTokens,
        totalOutputTokens: agent.totalOutputTokens,
        turnCount: agent.turnCount,
      };
      if (agent.maxInputTokens !== undefined) {
        entry.maxInputTokens = agent.maxInputTokens;
      }
      // Include estimated tokens if available
      if (agent.estimatedInputTokens !== undefined) {
        entry.estimatedInputTokens = agent.estimatedInputTokens;
      }
      // Only include hash fields if defined (exactOptionalPropertyTypes)
      if (agent.systemPromptHash)
        entry.systemPromptHash = agent.systemPromptHash.slice(0, 8);
      if (agent.agentTypeHash)
        entry.agentTypeHash = agent.agentTypeHash.slice(0, 8);
      if (agent.conversationHash)
        entry.conversationHash = agent.conversationHash.slice(0, 8);
      if (agent.parentConversationHash)
        entry.parentConversationHash = agent.parentConversationHash.slice(0, 8);
      agentSnapshots.push(entry);
    }

    const claimSnapshots: ClaimSnapshotEntry[] = claims
      .filter((c) => c.expiresAt > now)
      .map((c) => ({
        expectedChildAgentName: c.expectedChildAgentName,
        parentConversationHash: c.parentConversationHash.slice(0, 8),
        parentAgentTypeHash: c.parentAgentTypeHash.slice(0, 8),
        expiresIn: Math.round((c.expiresAt - now) / 1000),
      }));

    return {
      agents: agentSnapshots,
      claims: claimSnapshots,
      mainAgentId: mainAgentId?.slice(-8) ?? null,
      activeAgentId: activeAgentId?.slice(-8) ?? null,
    };
  }
}

// Singleton instance
export const treeDiagnostics = new TreeDiagnostics();
