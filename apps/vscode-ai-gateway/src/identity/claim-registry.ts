import { logger } from "../logger.js";

const CLAIM_EXPIRY_MS = 30_000;

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
    logger.debug(
      `[ClaimRegistry] Created claim for child "${expectedChildAgentName}"`,
      {
        parentConversationHash: parentConversationHash.substring(0, 8),
        expiresAt: new Date(claim.expiresAt).toISOString(),
      },
    );
  }

  /**
   * Match a new conversation to a pending claim.
   * Returns the parent's conversationHash if matched, null otherwise.
   *
   * Matching rules (in order):
   * 1. Primary: expectedChildAgentName matches detected agent name
   * 2. Secondary: expectedChildAgentTypeHash matches (if specified)
   * 3. Claims are matched FIFO by timestamp
   */
  matchClaim(detectedAgentName: string, agentTypeHash: string): string | null {
    const now = Date.now();

    // Filter to non-expired claims, sorted by timestamp (FIFO)
    const validClaims = this.claims
      .filter((c) => c.expiresAt > now)
      .sort((a, b) => a.timestamp - b.timestamp);

    for (const claim of validClaims) {
      // Primary match: agent name
      if (claim.expectedChildAgentName === detectedAgentName) {
        this.removeClaim(claim);
        logger.info(
          `[ClaimRegistry] Matched claim by name: "${detectedAgentName}"`,
        );
        return claim.parentConversationHash;
      }

      // Secondary match: agent type hash (if specified)
      if (claim.expectedChildAgentTypeHash === agentTypeHash) {
        this.removeClaim(claim);
        logger.info(
          `[ClaimRegistry] Matched claim by type hash: ${agentTypeHash.substring(0, 8)}`,
        );
        return claim.parentConversationHash;
      }
    }

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

  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.claims = [];
  }
}
