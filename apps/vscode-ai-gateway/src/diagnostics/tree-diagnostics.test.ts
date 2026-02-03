import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("fs", () => ({
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  renameSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

import * as fs from "fs";
import { TreeDiagnostics, type TreeSnapshot } from "./tree-diagnostics.js";

const baseAgent = (
  overrides: Partial<TreeSnapshot["agents"][number]> = {},
) => ({
  id: "agent-1",
  name: "main",
  isMain: false,
  status: "complete",
  inputTokens: 0,
  outputTokens: 0,
  maxObservedInputTokens: 0,
  totalOutputTokens: 0,
  turnCount: 0,
  ...overrides,
});

const baseSnapshot = (overrides: Partial<TreeSnapshot> = {}): TreeSnapshot => ({
  agents: [],
  claims: [],
  mainAgentId: null,
  activeAgentId: null,
  ...overrides,
});

describe("TreeDiagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("checkInvariants", () => {
    it("handles singleMainAgent with 0, 1, and 2 main agents", () => {
      const diagnostics = new TreeDiagnostics();

      const zeroMain = diagnostics.checkInvariants(baseSnapshot());
      expect(zeroMain.singleMainAgent).toBe(true);

      const oneMain = diagnostics.checkInvariants(
        baseSnapshot({
          agents: [baseAgent({ id: "agent-1", isMain: true })],
        }),
      );
      expect(oneMain.singleMainAgent).toBe(true);

      const twoMain = diagnostics.checkInvariants(
        baseSnapshot({
          agents: [
            baseAgent({ id: "agent-1", isMain: true }),
            baseAgent({ id: "agent-2", isMain: true }),
          ],
        }),
      );
      expect(twoMain.singleMainAgent).toBe(false);
    });

    it("validates children with and without parents", () => {
      const diagnostics = new TreeDiagnostics();

      const valid = diagnostics.checkInvariants(
        baseSnapshot({
          agents: [
            baseAgent({
              id: "parent",
              isMain: true,
              conversationHash: "parenthash",
            }),
            baseAgent({
              id: "child",
              parentConversationHash: "parenthash",
            }),
          ],
        }),
      );
      expect(valid.allChildrenHaveParent).toBe(true);

      const invalid = diagnostics.checkInvariants(
        baseSnapshot({
          agents: [
            baseAgent({ id: "child", parentConversationHash: "missing" }),
          ],
        }),
      );
      expect(invalid.allChildrenHaveParent).toBe(false);
    });

    it("detects orphan children", () => {
      const diagnostics = new TreeDiagnostics();

      const result = diagnostics.checkInvariants(
        baseSnapshot({
          agents: [
            baseAgent({ id: "child", parentConversationHash: "missing" }),
          ],
        }),
      );

      expect(result.noOrphanChildren).toBe(false);
    });

    it("validates claims have parents", () => {
      const diagnostics = new TreeDiagnostics();

      const valid = diagnostics.checkInvariants(
        baseSnapshot({
          agents: [
            baseAgent({
              id: "parent",
              conversationHash: "parenthash",
              agentTypeHash: "typehash",
            }),
          ],
          claims: [
            {
              expectedChildAgentName: "recon",
              parentConversationHash: "parenthash",
              parentAgentTypeHash: "typehash",
              expiresIn: 10,
            },
          ],
        }),
      );
      expect(valid.claimsHaveValidParent).toBe(true);

      const invalid = diagnostics.checkInvariants(
        baseSnapshot({
          claims: [
            {
              expectedChildAgentName: "recon",
              parentConversationHash: "missing",
              parentAgentTypeHash: "missingtype",
              expiresIn: 10,
            },
          ],
        }),
      );
      expect(invalid.claimsHaveValidParent).toBe(false);
    });

    it("validates mainAgentExists when agents present", () => {
      const diagnostics = new TreeDiagnostics();

      // No agents = mainAgentExists is true (vacuously)
      const empty = diagnostics.checkInvariants(baseSnapshot());
      expect(empty.mainAgentExists).toBe(true);

      // Agents with one main = true
      const withMain = diagnostics.checkInvariants(
        baseSnapshot({
          agents: [baseAgent({ id: "agent-1", isMain: true })],
        }),
      );
      expect(withMain.mainAgentExists).toBe(true);

      // Agents with no main = false
      const noMain = diagnostics.checkInvariants(
        baseSnapshot({
          agents: [baseAgent({ id: "agent-1", isMain: false })],
        }),
      );
      expect(noMain.mainAgentExists).toBe(false);
    });

    it("validates noDuplicateIds", () => {
      const diagnostics = new TreeDiagnostics();

      const unique = diagnostics.checkInvariants(
        baseSnapshot({
          agents: [baseAgent({ id: "agent-1" }), baseAgent({ id: "agent-2" })],
        }),
      );
      expect(unique.noDuplicateIds).toBe(true);

      const duplicate = diagnostics.checkInvariants(
        baseSnapshot({
          agents: [baseAgent({ id: "agent-1" }), baseAgent({ id: "agent-1" })],
        }),
      );
      expect(duplicate.noDuplicateIds).toBe(false);
    });

    it("validates noExpiredClaims", () => {
      const diagnostics = new TreeDiagnostics();

      const valid = diagnostics.checkInvariants(
        baseSnapshot({
          claims: [
            {
              expectedChildAgentName: "recon",
              parentConversationHash: "hash",
              parentAgentTypeHash: "type",
              expiresIn: 10, // positive = not expired
            },
          ],
        }),
      );
      expect(valid.noExpiredClaims).toBe(true);

      const expired = diagnostics.checkInvariants(
        baseSnapshot({
          claims: [
            {
              expectedChildAgentName: "recon",
              parentConversationHash: "hash",
              parentAgentTypeHash: "type",
              expiresIn: -5, // negative = expired
            },
          ],
        }),
      );
      expect(expired.noExpiredClaims).toBe(false);
    });
  });

  it("logs without context for backward compatibility", () => {
    const diagnostics = new TreeDiagnostics();
    const appendFileSync = vi.mocked(fs.appendFileSync);

    diagnostics.initialize("/tmp/test-workspace");
    appendFileSync.mockClear();

    diagnostics.log(
      "AGENT_STARTED",
      { agentId: "agent-1" },
      baseSnapshot({
        agents: [baseAgent({ id: "agent-1", isMain: true })],
      }),
    );

    expect(appendFileSync).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(appendFileSync.mock.calls[0]?.[1] as string);
    expect(logged.context).toBeUndefined();
    expect(logged.invariants).toBeDefined();
  });
});
