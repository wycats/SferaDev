# RFC 041: Transcript Capsule Agent Correlation

**Status**: Stage 0 (Idea)  
**Author**: Agent  
**Created**: 2026-02-03  
**Related**: RFC 031 (Status Bar Subagent Flows), RFC 040 (Token State Model)

## Summary

Embed invisible "capsules" (HTML comments) in assistant message content to persist agent correlation IDs across conversation turns. This enables reliable agent identification even when the extension restarts or context is lost.

## Motivation

### The Problem

Current agent correlation relies on:

1. **Request-scoped IDs** (`req-{hash}`) — Lost when request completes
2. **System prompt hashing** — Unreliable for subagents with similar prompts
3. **Temporal claim matching** — Fragile, requires active tracking

None of these survive:

- Extension restart mid-conversation
- Context window truncation
- Copy/paste of conversation history
- Multi-turn conversations where early context is summarized

### The Insight

The **transcript itself** is the only state that reliably persists across all these scenarios. By embedding correlation IDs directly in message content, we create a self-healing identification system.

## Design

### Capsule Format

```
<!-- v.cid:{conversationId} aid:{agentId} pid:{parentId} -->
```

- `cid`: Conversation ID (stable across all turns in a conversation)
- `aid`: Agent ID (identifies the specific agent that generated this response)
- `pid`: Parent agent ID (for subagent correlation, optional)

Example:

```
<!-- v.cid:conv_a1b2c3 aid:agent_x7y8z9 pid:agent_m4n5o6 -->
```

### Placement

Capsule is appended to the **end** of every assistant message content, after the visible text.

### Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│ 1. OUTBOUND: User sends message                             │
│    - Scan assistant messages for existing capsule           │
│    - Extract cid/aid/pid if found                           │
│    - Use for agent correlation                              │
├─────────────────────────────────────────────────────────────┤
│ 2. INBOUND: Assistant response streaming                    │
│    - Monitor stream for hallucinated capsule pattern        │
│    - If detected: CANCEL stream immediately                 │
│    - Append correct capsule after stream completes          │
├─────────────────────────────────────────────────────────────┤
│ 3. COMPLETION: Response finalized                           │
│    - Generate new cid if none found in history              │
│    - Generate aid for this response                         │
│    - Append capsule to response content                     │
└─────────────────────────────────────────────────────────────┘
```

### Hallucination Defense

Models may attempt to generate capsules themselves (they've seen HTML comments in training data). Defense:

1. **Pattern detection**: Buffer last 20 chars of stream, match `<!-- v.cid:` or `<!-- v.aid:`
2. **Immediate cancellation**: Call `cancellationTokenSource.cancel()` to stop generation
3. **Truncation**: Remove partial hallucinated capsule from output
4. **Correct injection**: Append the real capsule

```typescript
const CAPSULE_PATTERN = /<!-- v\.(cid|aid|pid):/;

function detectHallucinatedCapsule(buffer: string): boolean {
  return CAPSULE_PATTERN.test(buffer);
}
```

### ID Generation

```typescript
// Conversation ID: Stable across turns, generated once per conversation
function generateConversationId(): string {
  return `conv_${nanoid(10)}`;
}

// Agent ID: Unique per response, derived from request context
function generateAgentId(requestId: string): string {
  return `agent_${sha256(requestId).slice(0, 10)}`;
}
```

## Implementation

### Files to Modify

| File                                 | Change                                       |
| ------------------------------------ | -------------------------------------------- |
| `src/provider/openresponses-chat.ts` | Inject capsule after stream completes        |
| `src/provider/stream-adapter.ts`     | Detect hallucinated capsules, trigger cancel |
| `src/provider/request-builder.ts`    | Scan incoming messages for existing capsules |
| `src/status-bar/identity.ts`         | Capsule parsing/generation utilities         |
| `src/status-bar/types.ts`            | Add `conversationId` to agent tracking       |

### New Module: `src/capsule.ts`

```typescript
export interface Capsule {
  conversationId: string;
  agentId: string;
  parentId?: string;
}

export function parseCapsule(content: string): Capsule | null;
export function formatCapsule(capsule: Capsule): string;
export function extractCapsuleFromMessages(
  messages: LanguageModelChatMessage[],
): Capsule | null;
export function appendCapsule(content: string, capsule: Capsule): string;
```

### Stream Interception

```typescript
// In StreamAdapter or openresponses-chat.ts
class CapsuleGuard {
  private buffer = "";
  private readonly maxBuffer = 30;

  onChunk(text: string, cancel: () => void): string {
    this.buffer = (this.buffer + text).slice(-this.maxBuffer);

    if (detectHallucinatedCapsule(this.buffer)) {
      cancel();
      // Return text up to the hallucination start
      return truncateAtCapsuleStart(text);
    }

    return text;
  }
}
```

## Alternatives Considered

### 1. Metadata in API Response

**Rejected**: OpenResponses/VS Code LM API don't provide persistent conversation IDs that survive context truncation.

### 2. External State Store

**Rejected**: Doesn't survive extension restart without complex persistence. Capsule approach is self-contained.

### 3. System Prompt Injection

**Rejected**: Consumes tokens on every request. Capsule only adds ~30 tokens to assistant responses.

### 4. Zero-Width Characters

**Considered**: Could use `\u200B` (zero-width space) encoding instead of HTML comments. More invisible but harder to debug. HTML comments are a reasonable middle ground.

## Risks

| Risk                                  | Mitigation                                             |
| ------------------------------------- | ------------------------------------------------------ |
| Model references capsule in response  | Unlikely given placement at end; monitor in production |
| HTML comment renders in some contexts | Use obscure prefix `v.cid` unlikely to conflict        |
| Token overhead                        | ~30 tokens/response; acceptable for reliability        |
| Partial capsule in truncated context  | Parser handles incomplete capsules gracefully          |

## Success Criteria

1. Agent correlation survives extension restart
2. Subagent parent/child relationships are correctly identified
3. No visible artifacts in chat UI
4. Hallucination defense triggers <1% of responses (ideally 0%)

## Resolved Questions

### 1. Visibility of capsules

**Decision**: HTML comments are acceptable. They're invisible in rendered markdown but visible if user copies raw text. This is fine—the format is clearly machine-generated and power users may find it useful for debugging.

### 2. Checksum/nonce for hallucination defense

**Decision**: Not needed. Stream cancellation on pattern detection (`<!-- v.cid:`) is sufficient. The model never completes the hallucination, so validating correctness is moot.

### 3. Legacy conversations without capsules

**Decision**: Generate on next assistant response, graceful degradation for old messages.

- **New responses**: Always append capsule
- **Old responses**: Cannot modify; fall back to existing heuristics (system prompt hash, etc.)
- **Invariant**: Every assistant response we generate gets a capsule appended

This ensures redundancy—if early messages are truncated from context, later ones still carry the ID.

## References

- [RFC 031: Status Bar Design for Subagent Flows](00031-status-bar-design-for-subagent-flows.md)
- [RFC 040: Token State Model Simplification](00040-token-state-model-simplification.md)
- VS Code Language Model API: `LanguageModelChatMessage`
