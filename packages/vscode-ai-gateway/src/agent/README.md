# Agent Module

This module provides the core abstractions for tracking agent state in the VS Code AI Gateway extension.

## Overview

The agent module separates **registry concerns** (state, identity, events) from **UI concerns** (status bar display). This enables:

- Clean event-driven architecture for tree view updates
- Testable state management without VS Code UI dependencies
- Clear ownership boundaries for agent data

## Key Types

### AgentEntry

The primary agent state object. Contains:

- **Identity**: `id`, `conversationId`, `agentTypeHash`, `name`
- **Tokens**: `inputTokens`, `outputTokens`, `lastActualInputTokens`, `totalOutputTokens`
- **Lifecycle**: `status`, `turnCount`, `startTime`, `lastUpdateTime`
- **Relationships**: `parentConversationHash`, `childConversationHashes`, `isMain`
- **Estimation**: `estimatedInputTokens`, `estimatedDeltaTokens`, `estimationSource`

### AgentRegistry

Interface for agent lifecycle management:

```typescript
interface AgentRegistry {
  onDidChangeAgents: Event<AgentRegistryEvent>;
  startAgent(params: StartAgentParams): string;
  completeAgent(agentId: string, usage: TokenUsage): void;
  errorAgent(agentId: string): void;
  getAgents(): AgentEntry[];
  getAgentTurnCount(agentId: string): number;
  getAgentContext(conversationId: string): AgentContext | undefined;
  syncAgentTurnCount(conversationId: string, turnCount: number): void;
  createChildClaim(parentAgentId: string, expectedChildAgentName: string): void;
  updateAgentTitle(conversationId: string, title: string): void;
  linkChildAgent(
    parentConversationId: string,
    childConversationId: string,
  ): void;
  clearAgents(): void;
}
```

### AgentRegistryEvent

Discriminated union for all registry state changes. All events extend `AgentRegistryEventBase`:

```typescript
interface AgentRegistryEventBase {
  sequence: number; // Monotonically increasing for deterministic ordering
  timestamp: number;
}
```

Event types:

- `agent-started`: New agent or resumed conversation (includes `chatId`, `parentChatId`)
- `agent-completed`: Agent finished with token usage
- `agent-errored`: Agent encountered an error
- `agents-cleared`: All agents cleared
- `agent-updated`: Turn count sync, title generated, child linked, or main demoted
- `agent-removed`: Agent removed due to aging

All agent-specific events include `chatId` for causality tracking in InvestigationLogger.

## Ownership Rules

### 1. Turn Count Ownership

**Registry is the source of truth for turn counts.**

- `turnCount` is incremented in `completeAgent()` after each successful turn
- ConversationManager may detect drift via activity log and call `syncAgentTurnCount()`
- Sync only increases turn count, never decreases (monotonic)

### 2. Claim Resolution (Parent-Child Linking)

**FIFO with name/hash matching.**

When a parent agent calls `runSubagent`:

1. Parent calls `createChildClaim(parentAgentId, expectedChildName)`
2. Claim is stored with `parentConversationHash` and `parentAgentTypeHash`
3. When new agent starts, `matchChildClaim(name, agentTypeHash)` checks:
   - Name matches expected child name
   - Agent type hash differs from parent (it's a different agent type)
4. First matching claim wins (FIFO order)
5. Matched child gets `parentConversationHash` set

### 3. Subagent Resolution

**`parentConversationHash` links to parent's `conversationId` or `agentTypeHash`.**

Resolution order:

1. If parent has `conversationId` (stable UUID from stateful marker), use that
2. Otherwise, fall back to `agentTypeHash` as provisional identifier

This allows first-turn subagent calls to still create claims before the parent has a stable conversationId.

### 4. Main Agent Demotion

**New main demotes previous.**

- First agent to start becomes `isMain = true`
- If a new conversation starts (no conversationId match, no claim match), it becomes the new main
- Previous main is demoted (`isMain = false`) and an `agent-updated` event with `updateType: "main-demoted"` is emitted
- Main agent is never removed by aging (anchors the tree)

### 5. Agent Aging

**Completed agents age based on subsequent completions.**

- `completionOrder` tracks when each agent completed
- After `AGENT_DIM_AFTER_REQUESTS` (2) newer completions: agent is dimmed
- After `AGENT_REMOVE_AFTER_REQUESTS` (5) newer completions: agent is removed
- Exceptions:
  - Main agent is never removed
  - Agents with children in tree are never removed
  - Agents with pending claims are never removed

### 6. Identity Resolution

**Multiple IDs may map to the same canonical agent.**

- `agentIdAliases: Map<string, string>` maps request IDs to canonical agent IDs
- When a conversation resumes, new request ID is aliased to existing agent ID
- `resolveAgentId(agentId)` returns the canonical ID

### 7. Persistence (Fresh-Start Mode)

**No agent restoration on reload.**

- `initializePersistence()` sets up storage but doesn't restore agents
- Persisted state is only used for:
  - `getAgentContext()`: Delta token estimation for resumed conversations
  - `getPersistedTurnCount()`: Cross-reload turn count continuity
- Agent state is saved on `completeAgent()` and `syncAgentTurnCount()`

## Event Flow

```
Provider.startAgent()
    ↓
AgentRegistry.startAgent()
    ↓ emits AgentStartedEvent
ConversationManager.onDidChangeAgents()
    ↓
ConversationManager.rebuild()
    ↓
TreeView.refresh()
```

## Files

- `types.ts`: Core type definitions (AgentEntry, TokenUsage, etc.)
- `registry.ts`: AgentRegistry interface and event types
- `registry-impl.ts`: AgentRegistryImpl implementation
- `index.ts`: Barrel exports
