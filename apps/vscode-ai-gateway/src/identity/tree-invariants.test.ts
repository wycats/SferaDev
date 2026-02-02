/**
 * Property-based tests for agent tree invariants.
 *
 * These tests encode the expected composition rules for tree events
 * based on RFC 00033 (Conversation Identity Tracking).
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
  systemPromptHash: string;
  agentTypeHash: string;
  firstUserMessageHash: string;
  conversationHash?: string;
  parentConversationHash?: string;
}

/**
 * Simulated tree state for property testing.
 */
class TestTreeState {
  agents = new Map<string, TestAgent>();
  agentsByPartialKey = new Map<string, TestAgent>();
  mainAgentId: string | null = null;
  mainSystemPromptHash: string | null = null;
  claimRegistry = new ClaimRegistry();

  /**
   * Compute partialKey for an agent.
   */
  private computePartialKey(
    systemPromptHash: string,
    firstUserMessageHash: string,
  ): string {
    return `${systemPromptHash}:${firstUserMessageHash}`;
  }

  /**
   * Simulate startAgent logic (simplified from status-bar.ts).
   */
  startAgent(
    agentId: string,
    systemPromptHash: string,
    agentTypeHash: string,
    firstUserMessageHash: string,
  ): { action: "started" | "resumed"; agentId: string; claimMatched: boolean } {
    const partialKey = this.computePartialKey(
      systemPromptHash,
      firstUserMessageHash,
    );

    // Check for pending claim BEFORE partialKey matching
    const extractedName =
      this.mainSystemPromptHash &&
      systemPromptHash !== this.mainSystemPromptHash
        ? "sub"
        : "main";
    const claimMatch = this.claimRegistry.matchClaim(
      extractedName,
      agentTypeHash,
    );

    // If there's a claim match, this is a NEW agent (child), not a resume
    if (claimMatch) {
      const agent: TestAgent = {
        id: agentId,
        name: claimMatch.expectedChildName,
        isMain: false,
        systemPromptHash,
        agentTypeHash,
        firstUserMessageHash,
        parentConversationHash: claimMatch.parentConversationHash,
      };
      this.agents.set(agentId, agent);
      this.agentsByPartialKey.set(partialKey, agent);
      return { action: "started", agentId, claimMatched: true };
    }

    // Check for existing agent by partialKey
    const existingAgent = this.agentsByPartialKey.get(partialKey);
    if (existingAgent) {
      return {
        action: "resumed",
        agentId: existingAgent.id,
        claimMatched: false,
      };
    }

    // New agent
    const isMain =
      this.mainAgentId === null ||
      (this.mainSystemPromptHash !== null &&
        systemPromptHash === this.mainSystemPromptHash);

    const agent: TestAgent = {
      id: agentId,
      name: isMain ? "main" : "sub",
      isMain,
      systemPromptHash,
      agentTypeHash,
      firstUserMessageHash,
    };

    this.agents.set(agentId, agent);
    this.agentsByPartialKey.set(partialKey, agent);

    if (isMain && this.mainAgentId === null) {
      this.mainAgentId = agentId;
      this.mainSystemPromptHash = systemPromptHash;
    }

    return { action: "started", agentId, claimMatched: false };
  }

  /**
   * Simulate createChildClaim logic.
   */
  createChildClaim(parentAgentId: string, expectedChildName: string): boolean {
    const parent = this.agents.get(parentAgentId);
    if (!parent || !parent.agentTypeHash) return false;

    const parentIdentifier = parent.conversationHash ?? parent.agentTypeHash;
    this.claimRegistry.createClaim(
      parentIdentifier,
      parent.agentTypeHash,
      expectedChildName,
    );
    return true;
  }
}

describe("Tree Invariants", () => {
  let tree: TestTreeState;

  beforeEach(() => {
    tree = new TestTreeState();
  });

  describe("Invariant 1: First agent is always main", () => {
    it("should mark first agent as main regardless of hashes", () => {
      const result = tree.startAgent("agent-1", "hash-a", "type-a", "user-1");
      expect(result.action).toBe("started");
      expect(tree.agents.get("agent-1")?.isMain).toBe(true);
      expect(tree.mainAgentId).toBe("agent-1");
    });
  });

  describe("Invariant 2: Same partialKey resumes existing agent", () => {
    it("should resume when partialKey matches", () => {
      tree.startAgent("agent-1", "hash-a", "type-a", "user-1");
      const result = tree.startAgent("agent-2", "hash-a", "type-a", "user-1");

      expect(result.action).toBe("resumed");
      expect(result.agentId).toBe("agent-1"); // Returns canonical ID
      expect(tree.agents.size).toBe(1); // No new agent created
    });
  });

  describe("Invariant 3: Different systemPromptHash creates subagent", () => {
    it("should create new agent when systemPromptHash differs from main", () => {
      tree.startAgent("agent-1", "hash-main", "type-main", "user-1");
      const result = tree.startAgent(
        "agent-2",
        "hash-sub",
        "type-sub",
        "user-1",
      );

      expect(result.action).toBe("started");
      expect(tree.agents.get("agent-2")?.isMain).toBe(false);
      expect(tree.agents.size).toBe(2);
    });
  });

  describe("Invariant 4: Claim match creates child with correct name", () => {
    it("should match claim and use expected child name", () => {
      // Main agent starts
      tree.startAgent("agent-1", "hash-main", "type-main", "user-1");

      // Main creates claim for "recon"
      tree.createChildClaim("agent-1", "recon");

      // Subagent starts with different hash
      const result = tree.startAgent(
        "agent-2",
        "hash-sub",
        "type-sub",
        "user-1",
      );

      expect(result.action).toBe("started");
      expect(result.claimMatched).toBe(true);
      expect(tree.agents.get("agent-2")?.name).toBe("recon");
      expect(tree.agents.get("agent-2")?.parentConversationHash).toBe(
        "type-main",
      );
    });
  });

  describe("Invariant 5: Claim match takes precedence over partialKey", () => {
    it("should NOT resume if there's a pending claim for this agent type", () => {
      // Main agent starts
      tree.startAgent("agent-1", "hash-main", "type-main", "user-1");

      // Main creates claim for "recon"
      tree.createChildClaim("agent-1", "recon");

      // Another request with SAME partialKey as main but different systemPromptHash
      // This simulates the bug: subagent has same firstUserMessageHash
      const result = tree.startAgent(
        "agent-2",
        "hash-sub",
        "type-sub",
        "user-1",
      );

      // Should create new agent, NOT resume main
      expect(result.action).toBe("started");
      expect(result.claimMatched).toBe(true);
      expect(tree.agents.size).toBe(2);
    });
  });

  describe("Invariant 6: Expired claims don't match", () => {
    it("should not match expired claims", async () => {
      // Main agent starts
      tree.startAgent("agent-1", "hash-main", "type-main", "user-1");

      // Create claim with very short expiry (we'll manually expire it)
      tree.createChildClaim("agent-1", "recon");

      // Manually expire the claim by manipulating the registry
      // (In real code, we'd wait or mock time)
      const claims = tree.claimRegistry.getClaims();
      const firstClaim = claims[0];
      if (firstClaim !== undefined) {
        firstClaim.expiresAt = Date.now() - 1000; // Expired 1 second ago
      }

      // Subagent starts - claim should NOT match
      const result = tree.startAgent(
        "agent-2",
        "hash-sub",
        "type-sub",
        "user-1",
      );

      expect(result.claimMatched).toBe(false);
    });
  });

  describe("Invariant 7: FIFO matching for generic 'sub' name", () => {
    it("should match oldest claim when agent name is 'sub'", () => {
      tree.startAgent("agent-1", "hash-main", "type-main", "user-1");

      // Create two claims
      tree.createChildClaim("agent-1", "recon");
      tree.createChildClaim("agent-1", "execute");

      // Subagent starts - should match first claim (recon)
      const result = tree.startAgent(
        "agent-2",
        "hash-sub",
        "type-sub",
        "user-1",
      );

      expect(result.claimMatched).toBe(true);
      expect(tree.agents.get("agent-2")?.name).toBe("recon");

      // Second subagent should match second claim (execute)
      const result2 = tree.startAgent(
        "agent-3",
        "hash-sub2",
        "type-sub2",
        "user-1",
      );

      expect(result2.claimMatched).toBe(true);
      expect(tree.agents.get("agent-3")?.name).toBe("execute");
    });
  });
});

describe("Bug Reproduction: Same partialKey prevents subagent creation", () => {
  let tree: TestTreeState;

  beforeEach(() => {
    tree = new TestTreeState();
  });

  it("CURRENT BUG: subagent with same firstUserMessageHash merges into main", () => {
    // This test documents the current buggy behavior
    // Main agent starts
    tree.startAgent("agent-1", "hash-main", "type-main", "user-1");

    // Main creates claim for "recon"
    tree.createChildClaim("agent-1", "recon");

    // Subagent starts with SAME firstUserMessageHash but different systemPromptHash
    // In the buggy code, this would resume main because partialKey matches
    // In the fixed code, claim matching should take precedence
    const result = tree.startAgent("agent-2", "hash-sub", "type-sub", "user-1");

    // EXPECTED (fixed): Should create new agent with claim match
    expect(result.action).toBe("started");
    expect(result.claimMatched).toBe(true);
    expect(tree.agents.get("agent-2")?.name).toBe("recon");
  });
});
