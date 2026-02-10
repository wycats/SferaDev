/**
 * Property-based tests for agent tree invariants.
 *
 * These tests encode the expected composition rules for tree events
 * based on conversationId-based identity (GCMP pattern from RFC 00063).
 *
 * Identity model:
 * - conversationId (UUID from stateful_marker sessionId) is the sole identity key
 * - Agent resume is based on conversationId match via agentsByConversationId map
 * - Subagent detection uses ClaimRegistry (claim matching by agentTypeHash)
 * - agentTypeHash is diagnostics-only EXCEPT for claim linking
 * - firstUserMessageHash and systemPromptHash are diagnostics-only
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the logger before importing ClaimRegistry (which imports logger)
vi.mock("../logger.js", () => ({
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { ClaimRegistry } from "./claim-registry.js";

/**
 * Simulated agent entry for testing tree composition.
 */
interface TestAgent {
  id: string;
  name: string;
  isMain: boolean;
  agentTypeHash: string;
  conversationId: string;
  parentConversationHash?: string;
}

/**
 * Simulated tree state for property testing.
 * Models the conversationId-based identity system in status-bar.ts.
 */
class TestTreeState {
  agents = new Map<string, TestAgent>();
  agentsByConversationId = new Map<string, TestAgent>();
  mainAgentId: string | null = null;
  claimRegistry = new ClaimRegistry();

  /**
   * Simulate startAgent logic (simplified from status-bar.ts).
   *
   * AXIOM: Identity is based on conversationId ONLY.
   * - conversationId: authoritative identity (UUID from stateful_marker)
   * - agentTypeHash: diagnostics-only, except for claim linking
   * - Subagent detection: via claim registry, NOT hash comparison
   */
  startAgent(
    agentId: string,
    agentTypeHash: string,
    conversationId: string,
  ): { action: "started" | "resumed"; agentId: string; claimMatched: boolean } {
    // Check for existing agent by conversationId (authoritative identity)
    const existingAgent = this.agentsByConversationId.get(conversationId);

    // Check for pending claims only when there's no conversationId match
    if (!existingAgent) {
      const hasPendingClaims = this.claimRegistry.getPendingClaimCount() > 0;

      if (hasPendingClaims) {
        const extractedName = "sub";
        const claimMatch = this.claimRegistry.matchClaim(
          extractedName,
          agentTypeHash,
        );

        if (claimMatch) {
          const agent: TestAgent = {
            id: agentId,
            name: claimMatch.expectedChildName,
            isMain: false,
            agentTypeHash,
            conversationId,
            parentConversationHash: claimMatch.parentConversationHash,
          };
          this.agents.set(agentId, agent);
          this.agentsByConversationId.set(conversationId, agent);
          return { action: "started", agentId, claimMatched: true };
        }
      }
    }

    // Resume if conversationId matches
    if (existingAgent) {
      return {
        action: "resumed",
        agentId: existingAgent.id,
        claimMatched: false,
      };
    }

    // New agent — first agent is main, subsequent without claims = new main
    const isMain = this.mainAgentId === null;

    const agent: TestAgent = {
      id: agentId,
      name: isMain ? "main" : "sub",
      isMain,
      agentTypeHash,
      conversationId,
    };

    this.agents.set(agentId, agent);
    this.agentsByConversationId.set(conversationId, agent);

    if (isMain) {
      this.mainAgentId = agentId;
    }

    return { action: "started", agentId, claimMatched: false };
  }

  /**
   * Simulate createChildClaim logic.
   * Uses conversationId (if available) or agentTypeHash as parent identifier.
   */
  createChildClaim(parentAgentId: string, expectedChildName: string): boolean {
    const parent = this.agents.get(parentAgentId);
    if (!parent || !parent.agentTypeHash) return false;

    const parentIdentifier = parent.conversationId ?? parent.agentTypeHash;
    this.claimRegistry.createClaim(
      parentIdentifier,
      parent.agentTypeHash,
      expectedChildName,
    );
    return true;
  }
}

describe("Tree Invariants (conversationId-based identity)", () => {
  let tree: TestTreeState;

  beforeEach(() => {
    tree = new TestTreeState();
  });

  describe("Invariant 1: First agent is always main", () => {
    it("should mark first agent as main", () => {
      const result = tree.startAgent("agent-1", "type-a", "conv-1");
      expect(result.action).toBe("started");
      expect(tree.agents.get("agent-1")?.isMain).toBe(true);
      expect(tree.mainAgentId).toBe("agent-1");
    });
  });

  describe("Invariant 2: Same conversationId resumes existing agent", () => {
    it("should resume when conversationId matches", () => {
      tree.startAgent("agent-1", "type-a", "conv-1");
      const result = tree.startAgent("agent-2", "type-a", "conv-1");

      expect(result.action).toBe("resumed");
      expect(result.agentId).toBe("agent-1"); // Returns canonical ID
      expect(tree.agents.size).toBe(1); // No new agent created
    });

    it("should resume even when agentTypeHash changes between turns", () => {
      // agentTypeHash is diagnostics-only, conversationId is authoritative
      tree.startAgent("agent-1", "type-v1", "conv-1");
      const result = tree.startAgent("agent-2", "type-v2", "conv-1");

      expect(result.action).toBe("resumed");
      expect(result.agentId).toBe("agent-1");
    });
  });

  describe("Invariant 3: Different conversationId creates new agent", () => {
    it("should create new agent for different conversationId", () => {
      tree.startAgent("agent-1", "type-a", "conv-1");
      const result = tree.startAgent("agent-2", "type-a", "conv-2");

      expect(result.action).toBe("started");
      expect(tree.agents.size).toBe(2);
    });
  });

  describe("Invariant 4: Claim match creates child with correct name", () => {
    it("should match claim and use expected child name", () => {
      tree.startAgent("agent-1", "type-main", "conv-1");
      tree.createChildClaim("agent-1", "recon");

      // Subagent starts with its own conversationId
      const result = tree.startAgent("agent-2", "type-sub", "conv-2");

      expect(result.action).toBe("started");
      expect(result.claimMatched).toBe(true);
      expect(tree.agents.get("agent-2")?.name).toBe("recon");
      expect(tree.agents.get("agent-2")?.parentConversationHash).toBe("conv-1");
    });
  });

  describe("Invariant 5: No conversationId match + claim = child (not new main)", () => {
    it("should create child agent instead of new main when claim exists", () => {
      tree.startAgent("agent-1", "type-main", "conv-1");
      tree.createChildClaim("agent-1", "recon");

      // New agent with different conversationId — would be new main without claim
      const result = tree.startAgent("agent-2", "type-sub", "conv-2");

      expect(result.action).toBe("started");
      expect(result.claimMatched).toBe(true);
      expect(tree.agents.get("agent-2")?.isMain).toBe(false);
      expect(tree.agents.size).toBe(2);
    });
  });

  describe("Invariant 6: Expired claims don't match", () => {
    it("should not match expired claims", () => {
      tree.startAgent("agent-1", "type-main", "conv-1");
      tree.createChildClaim("agent-1", "recon");

      // Manually expire the claim
      const claims = tree.claimRegistry.getClaims();
      const firstClaim = claims[0];
      if (firstClaim !== undefined) {
        firstClaim.expiresAt = Date.now() - 1000;
      }

      const result = tree.startAgent("agent-2", "type-sub", "conv-2");

      expect(result.claimMatched).toBe(false);
    });
  });

  describe("Invariant 7: FIFO matching for generic 'sub' name", () => {
    it("should match oldest claim first", () => {
      tree.startAgent("agent-1", "type-main", "conv-1");

      tree.createChildClaim("agent-1", "recon");
      tree.createChildClaim("agent-1", "execute");

      // First subagent matches first claim (recon)
      const result = tree.startAgent("agent-2", "type-sub", "conv-2");
      expect(result.claimMatched).toBe(true);
      expect(tree.agents.get("agent-2")?.name).toBe("recon");

      // Second subagent matches second claim (execute)
      const result2 = tree.startAgent("agent-3", "type-sub2", "conv-3");
      expect(result2.claimMatched).toBe(true);
      expect(tree.agents.get("agent-3")?.name).toBe("execute");
    });
  });

  describe("Invariant 8: ConversationId match always resumes, even with pending claims", () => {
    it("should resume known agent even when claims are pending", () => {
      tree.startAgent("agent-1", "type-main", "conv-1");
      tree.createChildClaim("agent-1", "recon");

      // Same conversationId as main — should resume, NOT match claim
      const result = tree.startAgent("agent-2", "type-main", "conv-1");

      expect(result.action).toBe("resumed");
      expect(result.agentId).toBe("agent-1");
      expect(result.claimMatched).toBe(false);
      // Claim should still be pending (not consumed)
      expect(tree.claimRegistry.getPendingClaimCount()).toBe(1);
    });
  });
});

describe("ConversationId isolation prevents cross-conversation conflation", () => {
  let tree: TestTreeState;

  beforeEach(() => {
    tree = new TestTreeState();
  });

  it("agents with different conversationIds are never conflated", () => {
    // Two conversations with identical content but different conversationIds
    // This was the root cause of the >100% context bug with the old identity system
    tree.startAgent("agent-1", "type-a", "conv-1");
    const result = tree.startAgent("agent-2", "type-a", "conv-2");

    // Should NOT resume — different conversations
    expect(result.action).toBe("started");
    expect(tree.agents.size).toBe(2);
    expect(tree.agents.get("agent-1")?.conversationId).toBe("conv-1");
    expect(tree.agents.get("agent-2")?.conversationId).toBe("conv-2");
  });

  it("multi-turn conversation correctly resumes each turn", () => {
    // Turn 1
    tree.startAgent("t1-agent", "type-a", "conv-1");
    // Turn 2 (same conversation, different agentId from VS Code)
    const t2 = tree.startAgent("t2-agent", "type-a", "conv-1");
    // Turn 3
    const t3 = tree.startAgent("t3-agent", "type-a", "conv-1");

    expect(t2.action).toBe("resumed");
    expect(t3.action).toBe("resumed");
    expect(t2.agentId).toBe("t1-agent"); // canonical ID
    expect(t3.agentId).toBe("t1-agent"); // canonical ID
    expect(tree.agents.size).toBe(1); // single agent entry
  });
});
