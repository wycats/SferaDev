---
title: Conversation Identity Tracking
stage: 2
feature: agent-tracking
exo:
  tool: exo rfc create
  protocol: 1
---

# RFC 00033: Conversation Identity Tracking

# Conversation Identity Tracking

## Problem Statement

Current agent tracking is insufficient:

- `systemPromptHash` identifies agent TYPE (main vs recon vs execute), not conversation INSTANCE
- `chatId` is regenerated per-request with timestamp — useless for correlation
- `callId` from `runSubagent` tool call is NOT passed to child agent
- VS Code `sessionId` is stable per window but same for all agents

Result: Cannot correlate multiple requests within same conversation, cannot link parent→child agents.

## Goals

1. Uniquely identify each conversation instance (not just agent type)
2. Correlate multiple requests within the same conversation
3. Link parent agents to child (subagent) agents via temporal claim mechanism
4. Display agent hierarchy in TreeView with token counts

## Non-Goals

1. Persist conversation identity across VS Code restarts
2. Track conversations across multiple VS Code windows
3. Extract semantic agent names from system prompts (covered by RFC 00031)

## Proposed Solution

### Layer 1: Agent Type Hash

```
agentTypeHash = SHA-256(systemPromptHash + toolSetHash)[0:16]
```

- Stable for all requests of same agent type
- Different between main agent and each subagent type

### Layer 2: Conversation Instance Hash

```
conversationHash = SHA-256(agentTypeHash + firstUserMessageHash + firstAssistantResponseHash)[0:16]
```

- Stable within one conversation (first user message and response don't change)
- Different for each new conversation (user message provides uniqueness even if assistant response is generic)
- Computed AFTER first assistant response received

**Canonicalization Rules for `firstAssistantResponseHash`:**

- Use first text content only (exclude tool calls, function results)
- Truncate to first 500 characters
- Trim leading/trailing whitespace
- If no text content exists, use empty string hash

**Canonicalization Rules for `firstUserMessageHash`:**

- Use the full text of the first user message
- Trim leading/trailing whitespace

### Layer 3: Temporal Claim Mechanism

When parent streams `runSubagent` tool call:

1. Create `PendingChildClaim` with parent's `conversationHash`, timestamp, expected agent name, and expected `agentTypeHash` (if known)
2. When new conversation starts within 30s window, match claim using:
   - **Primary match**: `expectedChildAgentName` matches detected agent name, OR
   - **Secondary match**: `expectedAgentTypeHash` matches (if specified in claim)
   - **Reject**: Claims with mismatched agent names are NOT matched (prevents cross-conversation mis-association)
3. Link parent-child relationship

**Matching Priority:**

- Claims are matched in FIFO order by creation timestamp
- If multiple subagents of the same type exist, they are matched by creation order

## Data Structures

### Extended AgentEntry

```typescript
interface AgentEntry {
  // Existing fields...

  // NEW: Identity tracking
  agentTypeHash: string; // Computed once at conversation start, cached
  conversationHash: string | null; // null until first response, then updated in-place
  parentConversationHash: string | null;
  childConversationHashes: string[];

  // Cached inputs for hash computation
  firstUserMessageHash: string; // Computed from first request
  firstAssistantResponseHash: string | null; // Computed after first response
}
```

### PendingChildClaim

```typescript
interface PendingChildClaim {
  parentConversationHash: string;
  parentAgentTypeHash: string;
  expectedChildAgentName: string;
  expectedChildAgentTypeHash?: string; // Optional: if known from prior invocations
  timestamp: number;
  expiresAt: number; // timestamp + 30_000ms
}
```

## Hash Computation Lifecycle

### agentTypeHash Stability

The `agentTypeHash` is computed **once** at conversation start and cached for the lifetime of the `AgentEntry`. This addresses tool set instability:

- Tools may be dynamically filtered per-request
- Computing hash only at start ensures stability
- If tool set changes mid-conversation, the hash remains unchanged

### conversationHash Backfill

The `conversationHash` follows a two-phase lifecycle:

1. **First request**: `AgentEntry` created with `conversationHash: null`, `firstUserMessageHash` computed
2. **First response**: `firstAssistantResponseHash` computed, `conversationHash` computed and updated in-place
3. **Subsequent requests**: `conversationHash` used directly from cached value

## Implementation Phases

**Phase 1: Core Identity** - Create hash computation, extend AgentEntry
**Phase 2: Claim Registry** - Detect `runSubagent`, create/match claims
**Phase 3: TreeView Integration** - Show hierarchy, aggregate tokens
**Phase 4: Cleanup** - Expiration, orphan handling, configuration

## Edge Cases

| Case                                     | Handling                                               |
| ---------------------------------------- | ------------------------------------------------------ |
| First response is empty                  | Use empty string hash for `firstAssistantResponseHash` |
| First response is only tool calls        | Use empty string hash (no text content)                |
| First response exceeds 500 chars         | Truncate to first 500 characters before hashing        |
| Multiple `runSubagent` calls in parallel | Create multiple claims, FIFO matching by timestamp     |
| Multiple subagents of same type          | Match by creation order within same type               |
| Claim expires without match              | Log warning, child shows as orphan                     |
| VS Code restart mid-conversation         | State lost; new conversation starts fresh              |
| Tool set changes mid-conversation        | `agentTypeHash` unchanged (computed once at start)     |

## Success Criteria

1. Same conversation produces same `conversationHash` across multiple requests
2. Different agent types produce different `agentTypeHash`
3. > 95% of subagent calls correctly linked to parent within 30s window
4. TreeView correctly reflects actual agent relationships

## References

- RFC 00031: Status Bar Design for Subagent Flows (prior art)

## Detailed Implementation Specification

### File: `apps/vscode-ai-gateway/src/identity/hash-utils.ts` (NEW)

```typescript
import { createHash } from "node:crypto";
import type { LanguageModelTool } from "vscode";

/**
 * Compute a stable hash of the tool set.
 * Sorts tools by name to ensure stability regardless of order.
 */
export function computeToolSetHash(
  tools: readonly LanguageModelTool[],
): string {
  const sortedNames = tools.map((t) => t.name).sort();
  return createHash("sha256")
    .update(sortedNames.join("|"))
    .digest("hex")
    .substring(0, 16);
}

/**
 * Compute the agent type hash from system prompt and tool set.
 */
export function computeAgentTypeHash(
  systemPromptHash: string,
  toolSetHash: string,
): string {
  return createHash("sha256")
    .update(systemPromptHash + toolSetHash)
    .digest("hex")
    .substring(0, 16);
}

/**
 * Compute the conversation instance hash.
 * Called after first assistant response is received.
 */
export function computeConversationHash(
  agentTypeHash: string,
  firstUserMessageHash: string,
  firstAssistantResponseHash: string,
): string {
  return createHash("sha256")
    .update(agentTypeHash + firstUserMessageHash + firstAssistantResponseHash)
    .digest("hex")
    .substring(0, 16);
}

/**
 * Canonicalize and hash the first assistant response.
 * - Extract first text content only
 * - Truncate to 500 characters
 * - Trim whitespace
 */
export function hashFirstAssistantResponse(textContent: string): string {
  const canonical = textContent.trim().substring(0, 500);
  return createHash("sha256").update(canonical).digest("hex").substring(0, 16);
}

/**
 * Hash a user message for conversation identity.
 */
export function hashUserMessage(text: string): string {
  return createHash("sha256")
    .update(text.trim())
    .digest("hex")
    .substring(0, 16);
}
```

### File: `apps/vscode-ai-gateway/src/identity/claim-registry.ts` (NEW)

```typescript
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
      expectedChildAgentTypeHash,
      timestamp: now,
      expiresAt: now + CLAIM_EXPIRY_MS,
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

  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.claims = [];
  }
}
```

### File: `apps/vscode-ai-gateway/src/status-bar.ts` (MODIFY)

**Changes to `AgentEntry` interface:**

```typescript
export interface AgentEntry {
  // Existing fields (unchanged)
  id: string;
  name: string;
  startTime: number;
  lastUpdateTime: number;
  inputTokens: number;
  outputTokens: number;
  maxInputTokens?: number | undefined;
  estimatedInputTokens?: number | undefined;
  modelId?: string | undefined;
  status: "streaming" | "complete" | "error";
  contextManagement?: ContextManagementInfo | undefined;
  dimmed: boolean;
  isMain: boolean;
  completionOrder?: number | undefined;
  systemPromptHash?: string | undefined;

  // NEW: Identity tracking (RFC 00033)
  agentTypeHash?: string | undefined;
  conversationHash?: string | null | undefined; // null until first response
  parentConversationHash?: string | null | undefined;
  childConversationHashes?: string[] | undefined;
  firstUserMessageHash?: string | undefined;
  firstAssistantResponseHash?: string | null | undefined;
}
```

**Changes to `startAgent` method signature:**

```typescript
startAgent(
  agentId: string,
  estimatedTokens?: number,
  maxTokens?: number,
  modelId?: string,
  systemPromptHash?: string,
  // NEW parameters (RFC 00033)
  agentTypeHash?: string,
  firstUserMessageHash?: string,
): string
```

**Changes to `completeAgent` method:**

```typescript
completeAgent(
  agentId: string,
  usage: TokenUsage,
  // NEW parameter (RFC 00033)
  firstAssistantResponseText?: string,
): void {
  // ... existing code ...

  // NEW: Compute conversationHash on first completion
  if (agent.firstUserMessageHash && firstAssistantResponseText !== undefined) {
    const responseHash = hashFirstAssistantResponse(firstAssistantResponseText);
    agent.firstAssistantResponseHash = responseHash;
    if (agent.agentTypeHash) {
      agent.conversationHash = computeConversationHash(
        agent.agentTypeHash,
        agent.firstUserMessageHash,
        responseHash
      );
      logger.debug(`[StatusBar] Computed conversationHash: ${agent.conversationHash}`);
    }
  }
}
```

### File: `apps/vscode-ai-gateway/src/provider/openresponses-chat.ts` (MODIFY)

**Add runSubagent detection in the streaming loop:**

```typescript
// Inside the for-await loop, after emitting tool call parts:
if (part instanceof LanguageModelToolCallPart) {
  toolCallCount++;

  // NEW: Detect runSubagent tool calls for claim creation (RFC 00033)
  if (part.name === "runSubagent" || part.name === "run_subagent") {
    const args = part.input as
      | { agentName?: string; mode?: string }
      | undefined;
    const expectedChildName = args?.agentName ?? args?.mode ?? "unknown";

    // Create claim via status bar (which owns the ClaimRegistry)
    statusBar?.createChildClaim(chatId, expectedChildName);

    logger.info(
      `[OpenResponses] Detected runSubagent call: "${expectedChildName}"`,
    );
  }
}
```

### File: `apps/vscode-ai-gateway/src/agent-tree.ts` (MODIFY)

**Update `getChildren` to use parent-child relationships:**

```typescript
getChildren(element?: AgentTreeItem): AgentTreeItem[] {
  if (!this.statusBar) return [];
  const agents = this.statusBar.getAgents();

  if (!element) {
    // Root level: show only agents without parents
    const rootAgents = agents.filter(a => !a.parentConversationHash);
    return rootAgents
      .sort((a, b) => b.startTime - a.startTime)
      .map(agent => new AgentTreeItem(
        agent,
        this.hasChildren(agent, agents)
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None
      ));
  }

  // Children: find agents whose parentConversationHash matches this agent's conversationHash
  const children = agents.filter(
    a => a.parentConversationHash === element.agent.conversationHash
  );
  return children
    .sort((a, b) => a.startTime - b.startTime)
    .map(agent => new AgentTreeItem(agent, vscode.TreeItemCollapsibleState.None));
}

private hasChildren(agent: AgentEntry, allAgents: AgentEntry[]): boolean {
  return allAgents.some(a => a.parentConversationHash === agent.conversationHash);
}
```

## Test Cases

### Unit Tests: `apps/vscode-ai-gateway/src/identity/hash-utils.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import {
  computeToolSetHash,
  computeAgentTypeHash,
  computeConversationHash,
  hashFirstAssistantResponse,
  hashUserMessage,
} from "./hash-utils.js";

describe("computeToolSetHash", () => {
  it("produces same hash regardless of tool order", () => {
    const tools1 = [{ name: "read_file" }, { name: "write_file" }];
    const tools2 = [{ name: "write_file" }, { name: "read_file" }];
    expect(computeToolSetHash(tools1 as any)).toBe(
      computeToolSetHash(tools2 as any),
    );
  });

  it("produces different hash for different tool sets", () => {
    const tools1 = [{ name: "read_file" }];
    const tools2 = [{ name: "write_file" }];
    expect(computeToolSetHash(tools1 as any)).not.toBe(
      computeToolSetHash(tools2 as any),
    );
  });

  it("returns 16-character hex string", () => {
    const hash = computeToolSetHash([{ name: "test" }] as any);
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe("computeAgentTypeHash", () => {
  it("combines system prompt and tool set hashes", () => {
    const hash = computeAgentTypeHash("abc123", "def456");
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it("produces different hash for different inputs", () => {
    const hash1 = computeAgentTypeHash("abc", "def");
    const hash2 = computeAgentTypeHash("abc", "ghi");
    expect(hash1).not.toBe(hash2);
  });
});

describe("computeConversationHash", () => {
  it("combines all three inputs", () => {
    const hash = computeConversationHash("type", "user", "assistant");
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it("is stable for same inputs", () => {
    const hash1 = computeConversationHash("a", "b", "c");
    const hash2 = computeConversationHash("a", "b", "c");
    expect(hash1).toBe(hash2);
  });
});

describe("hashFirstAssistantResponse", () => {
  it("truncates to 500 characters", () => {
    const longText = "a".repeat(1000);
    const hash1 = hashFirstAssistantResponse(longText);
    const hash2 = hashFirstAssistantResponse("a".repeat(500));
    expect(hash1).toBe(hash2);
  });

  it("trims whitespace", () => {
    const hash1 = hashFirstAssistantResponse("  hello  ");
    const hash2 = hashFirstAssistantResponse("hello");
    expect(hash1).toBe(hash2);
  });

  it("handles empty string", () => {
    const hash = hashFirstAssistantResponse("");
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe("hashUserMessage", () => {
  it("trims whitespace", () => {
    const hash1 = hashUserMessage("  test  ");
    const hash2 = hashUserMessage("test");
    expect(hash1).toBe(hash2);
  });
});
```

### Unit Tests: `apps/vscode-ai-gateway/src/identity/claim-registry.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
    expect(match).toBe("parent-hash");
  });

  it("matches claim by type hash when name doesn't match", () => {
    registry.createClaim("parent-hash", "parent-type", "recon", "child-type");
    const match = registry.matchClaim("different-name", "child-type");
    expect(match).toBe("parent-hash");
  });

  it("returns null when no claim matches", () => {
    registry.createClaim("parent-hash", "parent-type", "recon");
    const match = registry.matchClaim("execute", "unknown-type");
    expect(match).toBeNull();
  });

  it("expires claims after 30 seconds", () => {
    registry.createClaim("parent-hash", "parent-type", "recon");
    vi.advanceTimersByTime(31_000);
    const match = registry.matchClaim("recon", "any");
    expect(match).toBeNull();
  });

  it("matches claims in FIFO order", () => {
    registry.createClaim("parent-1", "type", "recon");
    vi.advanceTimersByTime(100);
    registry.createClaim("parent-2", "type", "recon");

    const match1 = registry.matchClaim("recon", "any");
    expect(match1).toBe("parent-1");

    const match2 = registry.matchClaim("recon", "any");
    expect(match2).toBe("parent-2");
  });

  it("removes matched claims", () => {
    registry.createClaim("parent-hash", "parent-type", "recon");
    registry.matchClaim("recon", "any");
    const match = registry.matchClaim("recon", "any");
    expect(match).toBeNull();
  });
});
```

### Integration Test Outline: `apps/vscode-ai-gateway/src/test/suite/conversation-identity.test.ts`

```typescript
// Integration test outline - requires VS Code test harness
describe("Conversation Identity Tracking", () => {
  it("assigns same conversationHash across multiple requests in same conversation", async () => {
    // 1. Send first request
    // 2. Capture conversationHash after first response
    // 3. Send second request (same conversation)
    // 4. Verify conversationHash is identical
  });

  it("links parent to child when runSubagent is called", async () => {
    // 1. Start main agent request
    // 2. Main agent calls runSubagent("recon")
    // 3. Verify claim is created
    // 4. Start child agent request within 30s
    // 5. Verify child's parentConversationHash matches main's conversationHash
  });

  it("shows hierarchy in TreeView", async () => {
    // 1. Create parent-child relationship
    // 2. Query TreeView provider
    // 3. Verify parent shows as root
    // 4. Verify child shows as nested under parent
  });
});
```

## Migration Path

### Backward Compatibility

All new fields on `AgentEntry` are optional (`?` suffix), ensuring:

- Existing code continues to work without modification
- Status bar displays correctly even without identity tracking
- TreeView falls back to flat display when `parentConversationHash` is undefined

### Rollout Strategy

1. **Phase 1**: Deploy hash utilities and extended `AgentEntry` with null defaults
2. **Phase 2**: Enable claim registry (disabled by default via config flag)
3. **Phase 3**: Enable TreeView hierarchy display
4. **Phase 4**: Remove config flag, enable by default

### Configuration

```typescript
// In ConfigService
conversationIdentityEnabled: boolean = false; // Phase 1-2: opt-in
```
