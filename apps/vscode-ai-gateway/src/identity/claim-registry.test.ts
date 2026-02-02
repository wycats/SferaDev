import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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

describe("ClaimRegistry", () => {
  let registry: ClaimRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new ClaimRegistry();
  });

  afterEach(() => {
    registry.dispose();
    vi.useRealTimers();
  });

  it("matches claim by agent name", () => {
    registry.createClaim("parent-hash", "parent-type", "recon");
    const match = registry.matchClaim("recon", "child-type");
    expect(match).toEqual({
      parentConversationHash: "parent-hash",
      expectedChildName: "recon",
    });
  });

  it("matches claim by type hash when name doesn't match", () => {
    registry.createClaim("parent-hash", "parent-type", "recon", "child-type");
    const match = registry.matchClaim("different-name", "child-type");
    expect(match).toEqual({
      parentConversationHash: "parent-hash",
      expectedChildName: "recon",
    });
  });

  it("returns null when no claim matches", () => {
    registry.createClaim("parent-hash", "parent-type", "recon");
    const match = registry.matchClaim("execute", "unknown-type");
    expect(match).toBeNull();
  });

  it("expires claims after 90 seconds", () => {
    registry.createClaim("parent-hash", "parent-type", "recon");
    vi.advanceTimersByTime(91_000);
    const match = registry.matchClaim("recon", "any");
    expect(match).toBeNull();
  });

  it("matches claims in FIFO order", () => {
    registry.createClaim("parent-1", "type", "recon");
    vi.advanceTimersByTime(100);
    registry.createClaim("parent-2", "type", "recon");

    const match1 = registry.matchClaim("recon", "any");
    expect(match1?.parentConversationHash).toBe("parent-1");

    const match2 = registry.matchClaim("recon", "any");
    expect(match2?.parentConversationHash).toBe("parent-2");
  });

  it("removes matched claims", () => {
    registry.createClaim("parent-hash", "parent-type", "recon");
    registry.matchClaim("recon", "any");
    const match = registry.matchClaim("recon", "any");
    expect(match).toBeNull();
  });

  it("tracks pending claim count", () => {
    expect(registry.getPendingClaimCount()).toBe(0);
    registry.createClaim("parent-1", "type", "recon");
    expect(registry.getPendingClaimCount()).toBe(1);
    registry.createClaim("parent-2", "type", "execute");
    expect(registry.getPendingClaimCount()).toBe(2);
    registry.matchClaim("recon", "any");
    expect(registry.getPendingClaimCount()).toBe(1);
  });

  it("cleans up expired claims on interval", () => {
    registry.createClaim("parent-hash", "parent-type", "recon");
    expect(registry.getPendingClaimCount()).toBe(1);

    // Advance past expiry (90s) and cleanup interval (10s)
    vi.advanceTimersByTime(95_000);

    expect(registry.getPendingClaimCount()).toBe(0);
  });

  it("disposes cleanly", () => {
    registry.createClaim("parent-hash", "parent-type", "recon");
    registry.dispose();
    // After dispose, claims should be cleared
    expect(registry.getPendingClaimCount()).toBe(0);
  });
});
