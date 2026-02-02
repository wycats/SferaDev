# Handoff Document: Agent Tree Subagent Detection Fix

**Date**: February 2, 2026  
**Branch**: `feat/token-status-bar`  
**RFC**: 00033 (Conversation Identity Tracking)

---

## 1. Executive Summary

We're implementing an "agent tree" view that displays token usage for the main agent and its subagents. The core problem we've been debugging: **subagents weren't appearing as separate entries in the tree** - they were being merged into the main agent.

### Root Cause (Identified & Fixed)

Subagents can have the **same `systemPromptHash`** but **different `agentTypeHash`** (because they have different tools). The original `couldBeSubagent` check only looked at `systemPromptHash` differences, missing this case.

### Current Status

- ✅ Fix implemented and tests passing
- ✅ Extension built and installed
- ⏳ **Needs live testing** to confirm subagents appear correctly

---

## 2. Architecture Overview

### Identity Hashing (RFC 00033)

```
systemPromptHash = SHA-256(systemPrompt)[0:16]
toolSetHash = SHA-256(sorted tool names joined by "|")[0:16]
agentTypeHash = SHA-256(systemPromptHash + toolSetHash)[0:16]
firstUserMessageHash = SHA-256(first user message)[0:16]
partialKey = agentTypeHash + ":" + firstUserMessageHash
conversationHash = SHA-256(agentTypeHash + firstUserMessageHash + firstAssistantResponseHash)[0:16]
```

### Key Insight

- **Main agent** and **subagent** can share the same `systemPromptHash` (same base prompt)
- But they have **different `agentTypeHash`** because subagents have different tools
- The `partialKey` is based on `agentTypeHash`, so different tools = different partialKey

### Claim System

When main agent calls `runSubagent("recon")`:

1. A **claim** is created with `expectedChildAgentName: "recon"`
2. When the subagent request arrives, we try to **match the claim**
3. If matched, the subagent is created as a **child** with the correct name

---

## 3. The Bug & Fix

### Original Bug

In `status-bar.ts`, the subagent detection logic was:

```typescript
const couldBeSubagent = hasDifferentSystemPrompt && hasPendingClaims;
```

This failed when subagents had the **same systemPromptHash but different agentTypeHash**.

### The Fix (Applied)

```typescript
const hasDifferentSystemPrompt = systemPromptHash !== this.mainSystemPromptHash;
const hasDifferentAgentType = mainAgent?.agentTypeHash !== agentTypeHash;
const couldBeSubagent =
  (hasDifferentSystemPrompt || hasDifferentAgentType) && hasPendingClaims;
```

Now we check **both** conditions with OR logic.

### Location

[src/status-bar.ts#L380-L410](apps/vscode-ai-gateway/src/status-bar.ts#L380-L410)

---

## 4. Key Files Modified

### Core Implementation

| File                                                                                              | Purpose                                                 |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| [src/status-bar.ts](apps/vscode-ai-gateway/src/status-bar.ts)                                     | Main agent tracking, subagent detection, claim matching |
| [src/identity/claim-registry.ts](apps/vscode-ai-gateway/src/identity/claim-registry.ts)           | Temporal claim system for parent-child linking          |
| [src/diagnostics/tree-diagnostics.ts](apps/vscode-ai-gateway/src/diagnostics/tree-diagnostics.ts) | **NEW**: Flight recorder for debugging                  |
| [src/agent-tree.ts](apps/vscode-ai-gateway/src/agent-tree.ts)                                     | TreeView provider for VS Code sidebar                   |

### Tests

| File                                                                                                | Purpose                                            |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| [src/identity/tree-invariants.test.ts](apps/vscode-ai-gateway/src/identity/tree-invariants.test.ts) | **NEW**: Property tests for tree composition rules |
| [src/identity/claim-registry.test.ts](apps/vscode-ai-gateway/src/identity/claim-registry.test.ts)   | Claim registry unit tests (updated for 90s expiry) |

---

## 5. Diagnostic Tools

### Tree Diagnostics Log

Location: `.logs/tree-diagnostics.log`

This is a **flight recorder** that captures every event affecting the agent tree:

- `AGENT_STARTED` - New agent created
- `AGENT_RESUMED` - Existing agent resumed (partialKey match)
- `AGENT_COMPLETED` - Agent finished
- `CLAIM_CREATED` - Parent called runSubagent
- `CLAIM_MATCHED` - Subagent matched a pending claim

Each entry includes:

- JSON data with all relevant hashes
- Human-readable tree snapshot

**Example entry:**

```json
{
  "timestamp": "2026-02-02T17:30:00.000Z",
  "event": "AGENT_STARTED",
  "data": {
    "agentId": "abc12345",
    "isMain": false,
    "name": "recon",
    "agentTypeHash": "10805e3f",
    "claimMatched": true,
    "earlyClaimMatch": true
  },
  "treeText": "└─ [main] (263f3c15) ✓ 52.3k→1.2k [2]\n   └─ [recon] (10805e3f) ⏳ 0.0k→0.0k"
}
```

### Key Log Messages to Watch

In the VS Code Output panel (Vercel AI Gateway):

```
[StatusBar] Subagent detection check {"hasDifferentAgentType":true,"couldBeSubagent":true}
[StatusBar] Early claim match attempt {"claimMatched":true,"claimExpectedName":"recon"}
[StatusBar] Child Agent STARTED (claim matched) {"name":"recon"}
```

---

## 6. Test Commands

```bash
# Run all identity tests
cd apps/vscode-ai-gateway && pnpm test -- --run src/identity/

# Run specific test files
pnpm test -- --run src/identity/tree-invariants.test.ts
pnpm test -- --run src/identity/claim-registry.test.ts

# Build and install extension
# (Use VS Code task: "Build and Install Extension")
```

---

## 7. Live Testing Procedure

1. **Reload VS Code** after installing the extension
2. **Start a conversation** that triggers a subagent:
   - Ask: "Have a recon agent explore the codebase"
   - Or any task that uses `runSubagent`
3. **Check the Agent Tree view** in the sidebar
   - Main agent should show with turn count `[N]`
   - Subagent should appear as a **child** with its name (e.g., "recon")
4. **Check diagnostics** if issues:
   - Open `.logs/tree-diagnostics.log`
   - Look for `AGENT_STARTED` events
   - Verify `claimMatched: true` for subagents

### Expected Behavior

```
Agent Tree:
└─ claude-sonnet-4 [2] ✓ 52k/128k
   └─ recon ⏳ 8k/128k
```

### Bug Behavior (What We're Fixing)

```
Agent Tree:
└─ claude-sonnet-4 [2] ✓ 52k/128k
   (no children visible - subagent merged into main)
```

---

## 8. Known Issues / Edge Cases

### Pre-existing Test Failures

3 tests in `src/models.test.ts` fail due to unrelated `configService` issues in property-based tests. These are not related to our changes.

### Claim Expiry

Claims expire after **90 seconds** (increased from 30s). If a subagent takes longer to start, the claim will expire and the subagent won't be linked to its parent.

### First-Turn Subagent Calls

If the main agent calls `runSubagent` on its **first turn** (before completing), the claim uses `agentTypeHash` as a provisional parent identifier instead of `conversationHash`. This is handled by `reconcileProvisionalChildren()` when the parent completes.

---

## 9. Code Flow Summary

### When Main Agent Calls `runSubagent("recon")`

1. `openresponses-chat.ts` detects `runSubagent` tool call
2. Calls `statusBar.createChildClaim(chatId, "recon")`
3. `ClaimRegistry` stores claim with 90s expiry

### When Subagent Request Arrives

1. `provider.ts` calls `statusBar.startAgent()` with identity hashes
2. `startAgent()` computes `couldBeSubagent`:
   - `hasDifferentSystemPrompt` OR `hasDifferentAgentType`
   - AND `hasPendingClaims`
3. If `couldBeSubagent`, attempts early claim match
4. If claim matches, calls `createChildAgent()` (bypasses partialKey resume)
5. Child agent created with `parentConversationHash` linking to parent

---

## 10. Next Steps

1. **Live test** the fix with actual subagent invocations
2. **Verify** subagents appear in tree view with correct names
3. **Check** `.logs/tree-diagnostics.log` for any anomalies
4. If working, consider:
   - Adding more comprehensive integration tests
   - Documenting the identity system in the manual
   - Promoting RFC 00033 to Stage 3

---

## 11. Quick Reference

### Key Constants

```typescript
CLAIM_EXPIRY_MS = 90_000; // 90 seconds
AGENT_DIM_AFTER_REQUESTS = 2;
AGENT_REMOVE_AFTER_REQUESTS = 5;
```

### Key Methods

| Method                   | File              | Purpose                                 |
| ------------------------ | ----------------- | --------------------------------------- |
| `startAgent()`           | status-bar.ts     | Entry point for new agent tracking      |
| `createChildAgent()`     | status-bar.ts     | Creates claim-matched child agent       |
| `createChildClaim()`     | status-bar.ts     | Creates claim when runSubagent detected |
| `matchClaim()`           | claim-registry.ts | Matches incoming agent to pending claim |
| `computeAgentTypeHash()` | hash-utils.ts     | Computes identity hash                  |

### Diagnostic Commands

```bash
# View tree diagnostics
cat .logs/tree-diagnostics.log | jq -r '.treeText' | tail -20

# Search for specific events
grep "AGENT_STARTED" .logs/tree-diagnostics.log | jq '.data'

# Check claim creation
grep "CLAIM_CREATED" .logs/tree-diagnostics.log | jq '.data'
```
