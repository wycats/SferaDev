# RFC 041: Transcript Capsule Agent Correlation

**Status**: Stage 1 (Proposal)  
**Author**: Agent  
**Created**: 2026-02-03  
**Promoted**: 2026-02-03  
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
│ TURN 1: Fresh conversation                                  │
│   VS Code → [user message] → OpenResponses (VERBATIM)       │
│   OpenResponses → [assistant text, no capsule yet]          │
│   We inject capsule → [text + capsule] → VS Code            │
├─────────────────────────────────────────────────────────────┤
│ TURN 2+: Continuing conversation                            │
│   VS Code → [transcript with capsules] → OpenResponses      │
│   (VERBATIM - no sanitization, no modification)             │
│                                                             │
│   OpenResponses → [new assistant text, may hallucinate]     │
│   Process stream:                                           │
│     - Buffer tokens to detect capsule patterns              │
│     - If capsule mid-stream → ESCAPE, continue              │
│     - If capsule at end → REPLACE with correct ID           │
│     - If no capsule → APPEND correct capsule                │
│   Send processed response → VS Code                         │
└─────────────────────────────────────────────────────────────┘
```

**Key invariant**: Input is VERBATIM. All processing happens on OUTPUT only.

### Hallucination Defense

Models may emit capsule-like patterns because they see previous capsules in conversation history. Defense strategy: **buffer, detect, and handle gracefully** (never cancel).

#### Stream Buffering

Buffer incoming tokens to detect the capsule pattern `<!-- v.(cid|aid|pid):`. When pattern detected:

1. **Mid-stream** (more tokens follow): ESCAPE the pattern by replacing `.` with `·` (middle dot), continue streaming
2. **End of stream** (no more tokens): REPLACE with correct capsule ID

#### Why Not Cancel?

- Mid-message capsule = model is quoting/referencing (legitimate)
- End-of-message capsule = model hallucinated where real capsule goes (just fix it)
- Neither case requires stopping the stream

#### CapsuleGuard Interface

```typescript
class CapsuleGuard {
  private buffer = "";
  private readonly BUFFER_SIZE = 30;
  private readonly PATTERN = /<!-- v\.(cid|aid|pid):/;

  /**
   * Process a text delta. Returns text to emit immediately.
   * May hold back text in buffer if capsule pattern is pending.
   */
  processTextDelta(text: string): { emit: string; pending: string };

  /**
   * Finalize stream. Returns any buffered text with capsule
   * replaced (if hallucinated) or appended (if missing).
   */
  finalize(correctCapsule: Capsule): string;
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

| File                                 | Change                               |
| ------------------------------------ | ------------------------------------ |
| `src/provider/openresponses-chat.ts` | Stream processing with CapsuleGuard  |
| `src/identity/capsule-guard.ts`      | Buffer, detect, replace/escape logic |
| `src/identity/capsule.ts`            | Capsule parsing/formatting utilities |

### New Module: `src/identity/capsule.ts`

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

### Stream Processing

```typescript
// In openresponses-chat.ts
const guard = new CapsuleGuard();

for await (const event of stream) {
  if (event.type === "response.output_text.delta") {
    const { emit } = guard.processTextDelta(event.delta);
    if (emit) {
      progress.report(new LanguageModelTextPart(emit));
      accumulatedText += emit;
    }
  }
}

// After stream ends
const finalText = guard.finalize(capsule);
// finalText has correct capsule: replaced if hallucinated, appended if missing
```

## Alternatives Considered

### 1. Metadata in API Request

**Complementary, not alternative**: We could send the conversation ID via OpenResponses `metadata` on each request. This would let us know what ID to insert when the response comes back—without scanning previous messages.

However, `metadata` is currently OpenAI-only; Anthropic/Gemini/others silently drop it. See [vercel/ai-gateway#1153](https://github.com/vercel/ai-gateway/issues/1153).

**Current approach**: Scan previous assistant messages for existing capsule. If #1153 is fixed, we can optimize by sending the ID via `metadata` and skipping the scan.

### 2. External State Store

**Rejected**: Doesn't survive extension restart without complex persistence. Capsule approach is self-contained.

### 3. System Prompt Injection

**Rejected**: Consumes tokens on every request. Capsule only adds ~30 tokens to assistant responses.

### 4. Zero-Width Characters

**Considered**: Could use `\u200B` (zero-width space) encoding instead of HTML comments. More invisible but harder to debug. HTML comments are a reasonable middle ground.

## Risks

| Risk                                  | Mitigation                                                         |
| ------------------------------------- | ------------------------------------------------------------------ |
| Model hallucinates capsule at end     | Replace with correct ID (no cancellation needed)                   |
| Model quotes capsule mid-message      | Escape pattern, continue streaming                                 |
| HTML comment renders in some contexts | Use obscure prefix `v.cid` unlikely to conflict                    |
| Token overhead                        | ~30 tokens/response; acceptable for reliability                    |
| Partial capsule in truncated context  | Parser handles incomplete capsules gracefully                      |
| Escaped capsule visible to user       | Intentional; visible mutation signals it's a quote, aids debugging |

## Success Criteria

1. Agent correlation survives extension restart
2. Subagent parent/child relationships are correctly identified
3. No visible artifacts in chat UI
4. Hallucination defense triggers <1% of responses (ideally 0%)

## Resolved Questions

### 1. Visibility of capsules

**Decision**: HTML comments are acceptable. They're invisible in rendered markdown but visible if user copies raw text. This is fine—the format is clearly machine-generated and power users may find it useful for debugging.

### 2. Checksum/nonce for hallucination defense

**Decision**: Not needed. Buffer/escape/replace via CapsuleGuard handles both mid-stream quotes and end-of-message hallucinations without stopping the stream.

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
