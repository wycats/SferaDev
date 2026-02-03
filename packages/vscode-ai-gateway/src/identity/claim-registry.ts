import { logger } from "../logger.js";

// Subagents can take a while to start (VS Code processing, user interaction, etc.)
// 90 seconds provides buffer for slow starts while still cleaning up stale claims
const CLAIM_EXPIRY_MS = 90_000;

export interface PendingChildClaim {
  parentConversationHash: string;
  parentAgentTypeHash: string;
  expectedChildAgentName: string;
  expectedChildAgentTypeHash?: string;
  timestamp: number;
  expiresAt: number;
}

/**
 * Registry for pending child claims.
 * Manages the temporal claim mechanism for parent-child linking.
 */
export class ClaimRegistry {
  private claims: PendingChildClaim[] = [];
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Clean up expired claims every 10 seconds
    this.cleanupInterval = setInterval(() => this.cleanupExpired(), 10_000);
  }

  /**
   * Create a claim when parent streams a runSubagent tool call.
   */
  createClaim(
    parentConversationHash: string,
    parentAgentTypeHash: string,
    expectedChildAgentName: string,
    expectedChildAgentTypeHash?: string,
  ): void {
    const now = Date.now();
    const claim: PendingChildClaim = {
      parentConversationHash,
      parentAgentTypeHash,
      expectedChildAgentName,
      timestamp: now,
      expiresAt: now + CLAIM_EXPIRY_MS,
      ...(expectedChildAgentTypeHash !== undefined
        ? { expectedChildAgentTypeHash }
        : {}),
    };
    this.claims.push(claim);
    logger.info(
      `[ClaimRegistry] Created claim for child "${expectedChildAgentName}"`,
      {
        parentConversationHash: parentConversationHash.substring(0, 8),
        parentAgentTypeHash: parentAgentTypeHash.substring(0, 8),
        expiresAt: new Date(claim.expiresAt).toISOString(),
        totalClaims: this.claims.length,
      },
    );
  }

  /**
   * Match result containing parent hash and expected child name.
   * Matches by agent name first, then by type hash, then FIFO for generic "sub" agents.
   */
  matchClaim(
    detectedAgentName: string,
    agentTypeHash: string,
  ): { parentConversationHash: string; expectedChildName: string } | null {
    const now = Date.now();

    // Filter to non-expired claims, sorted by timestamp (FIFO)
    const validClaims = this.claims
      .filter((c) => c.expiresAt > now)
      .sort((a, b) => a.timestamp - b.timestamp);

    // First, try to match by agent name (FIFO order)
    for (const claim of validClaims) {
      if (claim.expectedChildAgentName === detectedAgentName) {
        this.removeClaim(claim);
        logger.info(
          `[ClaimRegistry] Matched claim for "${claim.expectedChildAgentName}" (by name)`,
          {
            agentTypeHash: agentTypeHash.substring(0, 8),
            parentHash: claim.parentConversationHash.substring(0, 8),
          },
        );
        return {
          parentConversationHash: claim.parentConversationHash,
          expectedChildName: claim.expectedChildAgentName,
        };
      }
    }

    // Second, try to match by type hash if the claim has one
    for (const claim of validClaims) {
      if (
        claim.expectedChildAgentTypeHash &&
        claim.expectedChildAgentTypeHash === agentTypeHash
      ) {
        this.removeClaim(claim);
        logger.info(
          `[ClaimRegistry] Matched claim for "${claim.expectedChildAgentName}" (by type hash)`,
          {
            agentTypeHash: agentTypeHash.substring(0, 8),
            parentHash: claim.parentConversationHash.substring(0, 8),
          },
        );
        return {
          parentConversationHash: claim.parentConversationHash,
          expectedChildName: claim.expectedChildAgentName,
        };
      }
    }

    // Third, if the detected name is generic ("sub"), match FIFO
    // This handles the case where extractAgentName returns "sub" for all subagents
    // but the claim has the actual expected name from runSubagent
    const firstClaim = validClaims[0];
    if (detectedAgentName === "sub" && firstClaim !== undefined) {
      this.removeClaim(firstClaim);
      logger.info(
        `[ClaimRegistry] Matched claim for "${firstClaim.expectedChildAgentName}" (FIFO for generic "sub")`,
        {
          agentTypeHash: agentTypeHash.substring(0, 8),
          parentHash: firstClaim.parentConversationHash.substring(0, 8),
        },
      );
      return {
        parentConversationHash: firstClaim.parentConversationHash,
        expectedChildName: firstClaim.expectedChildAgentName,
      };
    }

    // No match found - log for debugging
    logger.info(`[ClaimRegistry] No claim matched for "${detectedAgentName}"`, {
      agentTypeHash: agentTypeHash.substring(0, 8),
      validClaimsCount: validClaims.length,
      claimNames: validClaims.map((c) => c.expectedChildAgentName),
    });

    return null;
  }

  private removeClaim(claim: PendingChildClaim): void {
    const idx = this.claims.indexOf(claim);
    if (idx >= 0) {
      this.claims.splice(idx, 1);
    }
  }

  private cleanupExpired(): void {
    const now = Date.now();
    const before = this.claims.length;
    this.claims = this.claims.filter((c) => c.expiresAt > now);
    const removed = before - this.claims.length;
    if (removed > 0) {
      logger.debug(`[ClaimRegistry] Cleaned up ${removed} expired claims`);
    }
  }

  /**
   * Get the count of pending claims (for testing/debugging).
   */
  getPendingClaimCount(): number {
    return this.claims.filter((c) => c.expiresAt > Date.now()).length;
  }

  /**
   * Get all claims (for diagnostics snapshot).
   */
  getClaims(): PendingChildClaim[] {
    return [...this.claims];
  }

  /**
   * Clear all pending claims without disposing the registry.
   */
  clearAll(): void {
    const count = this.claims.length;
    this.claims = [];
    if (count > 0) {
      logger.debug(`[ClaimRegistry] Cleared ${count} claims`);
    }
  }

  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.claims = [];
  }
}
