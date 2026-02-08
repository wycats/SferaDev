# Session Handoff Notes

## Context

We're investigating why subagents (spawned via `runSubagent`) don't appear in the sidebar.

## Key Findings

### 1. The Sidebar Reads from TokenStatusBar

The sidebar (`agent-tree.ts`) is a read-only view of `TokenStatusBar.agents`. It doesn't manage state.

```
TokenStatusBar.agents → AgentTreeDataProvider.getChildren() → TreeView
```

### 2. Child Agents Require Claim Matching

For a child to appear:

1. Parent calls `runSubagent` → `createChildClaim()`
2. Child starts → `startAgent()` → `matchChildClaim()`
3. If matched → `createChildAgent()` with `isMain: false`

### 3. The Child Never Calls startAgent()

Evidence:

- `CLAIM_CREATED` fires (parent side works)
- Child runs successfully (forensic capture exists)
- No `AGENT_STARTED` with `claimMatched: true` (child never enters our code)
- Claim expires after 90 seconds

### 4. Timing Anomaly

```
Child forensic capture: 05:33:19.386Z
Parent AGENT_STARTED:   05:33:19.391Z (5ms later)
```

The child's capture happened **before** the parent even registered as started. This suggests parallel execution, not sequential.

### 5. Signal Inventory (What's Available)

**Parent side** (tree-diagnostics.log):

- `agentId`, `systemPromptHash`, `agentTypeHash`, `conversationHash`
- `expectedChildAgentName` from CLAIM_CREATED

**Child side** (forensic-captures.jsonl):

- `chatId`, `systemPromptHash` (full), `messageCount`, `timestamp`

**Not useful as join keys**:

- `chatId` suffix matching `agentId` = timestamp coincidence
- `systemPromptHash` = same for all agent-mode sessions (26 sessions share it)

### 6. The Designed Solution (Claims) Isn't Working

The claim mechanism is correct in design:

- Parent creates claim with expected child name
- Child should match by name or type hash
- Child gets `parentConversationHash` linking to parent

But the child **never reaches the matching code** because it doesn't call `startAgent()`.

## Next Steps

1. **Trace `startAgent()` call sites**
   - Find all places that call `TokenStatusBar.startAgent()`
   - Determine if subagents bypass this path

2. **Check provider registration**
   - Does our provider intercept all chat requests?
   - Do subagents use a different provider?

3. **Verify extension instance**
   - Are parent and child in the same VS Code window?
   - Does each window have its own extension instance?

4. **Add entry-point logging**
   - Log at the very start of `provideLanguageModelResponse()`
   - See if child requests even reach our code

## Files Created This Session

- `docs/SIDEBAR_ARCHITECTURE.md` - How the sidebar works
- `docs/PARENT_CHILD_SIGNAL_INVENTORY.md` - Available signals on each side
- `docs/SESSION_HANDOFF.md` - This file

## Files Modified This Session

- `docs/VERIFICATION_WORKFLOW.md` - Added model identity verification section (later found to contain incorrect claims about `gpt-5.2-codex` being a fallback - this was wrong, it was just a different session)

## Corrections Made

1. **`gpt-5.2-codex` is NOT a fallback model** - It appeared in logs because it was a completely separate chat session where that model was selected, not because of any fallback mechanism.

2. **`systemPromptHash` prefix match is NOT a hash property** - It's just truncation (`.slice(0, 8)`) in the tree-diagnostics log vs full hash in forensic captures.

3. **`chatId` suffix does NOT embed parent `agentId`** - Both are derived from `Date.now()`, so timestamps naturally overlap. Not an intentional link.
