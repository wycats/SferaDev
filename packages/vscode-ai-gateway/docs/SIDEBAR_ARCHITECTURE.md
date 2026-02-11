# Sidebar (Agent Tree) Architecture

## Overview

The sidebar displays agent hierarchy via VS Code's TreeView API. It shows main agents and their children with token usage.

**Key Files**:

- `src/agent-tree.ts` - TreeDataProvider and TreeItem classes
- `src/status-bar.ts` - Agent state management (the sidebar reads from here)
- `src/identity/claim-registry.ts` - Parent-child claim matching

## Data Flow

```
TokenStatusBar.agents (Map<string, AgentEntry>)
       ↓
AgentTreeDataProvider.getChildren()
       ↓
AgentTreeItem[] → VS Code TreeView ("vercel.ai.agentTree")
```

The sidebar is a **read-only view** of `TokenStatusBar.agents`. It doesn't manage state itself.

## How Agents Enter the Sidebar

### Main Agents

1. `provider.ts` calls `statusBar.startAgent()` when a chat request begins
2. `startAgent()` creates an `AgentEntry` with `isMain: true`
3. Entry added to `this.agents` Map
4. `_onDidChangeAgents` fires → sidebar refreshes

### Child Agents (Subagents)

For a child to appear, this sequence must succeed:

1. **Parent streams `runSubagent` tool call**
   - `openresponses-chat.ts` detects the tool call
   - Calls `statusBar.createChildClaim(parentAgentId, expectedChildName)`
   - `ClaimRegistry` stores the claim (expires in 90 seconds)

2. **Child agent starts**
   - Child's request hits `statusBar.startAgent()`
   - `startAgent()` checks `hasPendingClaims`
   - Calls `matchChildClaim(extractedName, agentTypeHash)`

3. **Claim matches**
   - `ClaimRegistry.matchClaim()` tries: name match → type hash match → FIFO for "sub"
   - If matched → `createChildAgent()` creates entry with `isMain: false`
   - Entry gets `parentConversationHash` linking it to parent

4. **Sidebar displays hierarchy**
   - `getChildren()` finds root agents (no parent or orphaned)
   - For each root, `getChildAgents()` finds children by `parentConversationHash`

## Current Problem: Children Not Appearing

### Observed Behavior

- `CLAIM_CREATED` event fires when parent calls `runSubagent`
- No `AGENT_STARTED` with `claimMatched: true` ever appears
- Claim expires after 90 seconds

### Hypothesis

The child agent's request **never calls `startAgent()`**. Possible reasons:

1. Child runs in a different extension instance (different window?)
2. Child's code path bypasses the status bar entirely
3. The provider registration doesn't intercept subagent requests

### Evidence from Logs

```
Parent side (tree-diagnostics.log):
  05:33:19.391Z - AGENT_STARTED (parent, agentId: 28799370)
  05:33:24.625Z - CLAIM_CREATED for "recon"
  05:33:25.423Z - AGENT_COMPLETED (parent)

```

## Claim Matching Logic

From `claim-registry.ts`:

```typescript
matchClaim(detectedAgentName, agentTypeHash):
  1. Try exact name match (FIFO order)
  2. Try type hash match (if claim has expectedChildAgentTypeHash)
  3. If detectedAgentName === "sub", match first claim (FIFO)
  4. Return null if no match
```

## Agent Hierarchy in TreeView

```typescript
// Root level: agents with no parent OR orphaned agents
const rootAgents = agents.filter(
  (a) =>
    !a.parentConversationHash ||
    !parentIdentifiers.has(a.parentConversationHash),
);

// Children: linked via parentConversationHash
const children = agents.filter(
  (a) =>
    a.parentConversationHash === parent.conversationHash ||
    a.parentConversationHash === parent.agentTypeHash,
);
```

## Next Steps to Investigate

1. **Trace `startAgent()` call sites** - Find all places that call it
2. **Check if subagents use the same provider** - They might bypass our registered provider
3. **Verify extension instance** - Are parent and child in the same VS Code window?
4. **Add logging at provider entry point** - See if child requests even reach our code
