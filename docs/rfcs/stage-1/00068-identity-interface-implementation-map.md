---
title: Identity Interface — Implementation Map
feature: Unknown
exo:
    tool: exo rfc create
    protocol: 1
---

# RFC 00068: Identity Interface — Implementation Map

RFC 00066: Interface-First API Alignment
Goal: design-identity-interface, Task: map-implementations

## Interface → Implementation Mapping

### Implementation 1: StatefulMarkerIdentityProvider (Current Workaround)

| Interface Method | Current Code | Notes |
|---|---|---|
| `resolve(messages, modelId)` | `findLatestStatefulMarker(chatMessages, model.id)` in `provider.ts:247` + `randomUUID()` fallback at `:248` | Returns `IdentityResolution { conversationId: marker?.sessionId ?? randomUUID(), source: marker ? "marker" : "generated", lastResponseId: marker?.responseId, isNew: !marker }` |
| `name` | `"stateful-marker"` | — |
| `markerEmitter.createMarker(id, modelId, responseId)` | `encodeStatefulMarker(modelId, {...})` in `stream-adapter.ts:545-556` | Returns `{ data: encodeStatefulMarker(...), mimeType: "stateful_marker" }` |

**Files touched:**
- `src/utils/stateful-marker.ts` — encode/decode/find functions (unchanged, wrapped)
- `src/provider.ts:247-248` — replace inline `findLatestStatefulMarker` + `randomUUID()` with `identityService.resolve()`
- `src/provider/stream-adapter.ts:545-556` — replace inline `encodeStatefulMarker()` with `identityService.markerEmitter?.createMarker()`
- `src/provider/openresponses-chat.ts:291-292` — `prompt_cache_key = resolution.conversationId` (consumer, no interface change)

**Migration path:** Wrap existing functions, no behavior change.

### Implementation 2: ChatSessionIdentityProvider (Future — chatSessionsProvider)

| Interface Method | Proposal API | Notes |
|---|---|---|
| `resolve(messages, modelId)` | `ChatContext.chatSessionContext.chatSessionItem.resource.toString()` | Returns `IdentityResolution { conversationId: resource.toString() as ConversationId, source: "session-provider", isNew: chatSessionItem.timing?.lastRequestStarted === undefined }` |
| `name` | `"chat-session-provider"` | — |
| `markerEmitter` | `undefined` | chatSessionsProvider manages identity natively — no markers needed |

**Proposal API surface used:**
- `ChatContext.chatSessionContext` — provides `ChatSessionItem` for the current session
- `ChatSessionItem.resource` (Uri) — canonical session identity
- `ChatSessionItem.timing.lastRequestStarted` — detect first turn
- `ChatSessionItem.metadata` — could store our `PersistedAgentState` (but persistence is separate concern)

**Prerequisite:** Extension must register as a `ChatParticipant` to access `ChatContext.chatSessionContext`. Currently we are provider-only. This is a significant architectural change.

**Migration path:** Add participant registration, implement `ChatSessionContentProvider`, wire `ChatContext` into the identity resolution path.

### Implementation 3: agentSessionsWorkspace (Orthogonal)

This proposal (`workspace.isAgentSessionsWorkspace: boolean`) is NOT an identity provider. It's a workspace-type flag.

**Potential use:** Could be used as a signal to choose between implementations:
```typescript
const identityProvider = workspace.isAgentSessionsWorkspace
  ? new AgentWorkspaceIdentityProvider()  // Optimized for agent sessions
  : new StatefulMarkerIdentityProvider(); // General-purpose fallback
```

But this is speculative — the flag doesn't provide identity, just context about the workspace type.

## Consumer Migration Map

These consumers currently use `conversationId: string` directly. With the interface, they'd receive `ConversationId` (branded string) from `IdentityResolution`:

| Consumer | Current Usage | Migration |
|---|---|---|
| `provider.ts` | `const conversationId = statefulMarker?.sessionId ?? randomUUID()` | `const resolution = identityService.resolve(messages, modelId); const conversationId = resolution.conversationId;` |
| `openresponses-chat.ts` | `prompt_cache_key = sessionId` | `prompt_cache_key = resolution.conversationId` (no change, just typed) |
| `status-bar.ts` | `agentsByConversationId.get(conversationId)` | Same — `ConversationId` is a string, Map works unchanged |
| `persistence/stores.ts` | `entries[conversationId]` | Same — Record<string, ...> accepts ConversationId |
| `investigation.ts` | `this.startData.conversationId` | Same — string field |
| `tree-diagnostics.ts` | `agent.conversationId` | Same — string field |
| `agent-tree.ts` | `a.conversationId === lastConversationId` | Same — string comparison |

**Key insight:** Because `ConversationId` is a branded string, ALL existing consumers work unchanged. The branding prevents accidental construction from arbitrary strings but doesn't break existing string operations.

## Adoption Strategy

### Phase 1: Extract (No behavior change)
1. Create `ConversationIdentityService` with `StatefulMarkerIdentityProvider`
2. Replace inline code in `provider.ts` and `stream-adapter.ts` with service calls
3. All tests pass unchanged

### Phase 2: Prepare for chatSessionsProvider
1. Add `ChatSessionIdentityProvider` implementation (behind feature flag)
2. Add participant registration infrastructure
3. Wire `ChatContext` into identity resolution

### Phase 3: Switch (When chatSessionsProvider stabilizes)
1. Enable `ChatSessionIdentityProvider` as primary
2. Keep `StatefulMarkerIdentityProvider` as fallback
3. Remove marker emission when chatSessionsProvider is the only path
