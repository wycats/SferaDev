---
title: Transcript Digest Correlation for Token Tracking
stage: 0
feature: Unknown
exo:
    tool: exo rfc create
    protocol: 1
---

# RFC 00043: Transcript Digest Correlation for Token Tracking

> **Stage**: 0 (Idea)
> **Created**: 2026-02-04
> **Status**: Draft

## Summary

Design a system to correlate token counts with conversation transcripts using content digests, accepting that conversation identity is fundamentally ambiguous in our architectural position as a Language Model Provider.

## Problem Statement

We want to:
1. Count tokens per chat window and per agent
2. Identify summarization events to treat post-summarization as new context
3. Link child agents to parent agents (ideally)
4. Show accurate token counts in the VS Code status bar

**The fundamental constraint**: We are a Language Model Provider, not a Chat Participant. We receive a message list, stream a response, then receive an updated message list. Anything we want to persist must survive this handoff — but we have no stable conversation identifier from VS Code.

## User's Original Requirements (Verbatim)

These constraints drive the design:

- We want to be able to count the number of tokens in each chat window and each agent in the chat window
- We want to be able to identify summarization, so we can treat post-summarization chats as either a separate agent or at least a different context
- Ideally we would be able to link child agents to their parent reliably, and this might involve summarization
- The user can switch models to us mid-chat, so we can't rely on being the first model provider in a conversation
- The tool list can change mid-chat, so it's not a reliable source for fingerprinting
- System prompts can be the same across chats and agents, so it's not a reliable source for agent fingerprinting
- We're a language model not a chat participant
- We could implement other parts of the VS Code API, but we want our language model to work seamlessly with the default Copilot participant
- We could potentially use OpenResponses features, but not all features are consistently implemented
- Fundamentally, a core part of the loop involves us giving messages back from the language model API, and receiving a new message list from VS Code with updates. **Anything we want to persist across a conversation to give us a stable identity needs to survive that handoff.**

## Architectural Axioms

These are accepted realities that shape the solution:

**A1. Identity Ambiguity is Architectural**
We cannot know conversation identity on turn 1. Multiple conversations may share the same transcript prefix. Two users asking "help me write a function" in the same workspace will have identical `[System, User1]` message lists.

**A2. Equivalence Suffices for Token Counting**
`tokens(transcript_A) == tokens(transcript_B)` when `transcript_A == transcript_B`. For the purpose of showing accurate token counts, we don't need unique identity — equivalent transcripts have equivalent counts.

**A3. Storage is Keyed by Digest**
```
Memento: Map<digest(transcript), TokenUsage>
```
LRU eviction is safe. Hundreds or thousands of entries is acceptable.

**A4. OpenResponses is Authoritative for Token Counts**
OpenResponses returns `usage` with `input_tokens` and `output_tokens`. This is the source of truth. We correlate these counts with the transcript that produced them.

**A5. Identity Matters Only For:**
1. **Pruning safety** — LRU handles this without needing true identity
2. **Parent-child linking** — Currently unsolved (see Open Questions)

## Verified Findings

### OpenResponses Usage

| Claim | Status | Evidence |
|-------|--------|----------|
| Returns `usage` with `input_tokens`/`output_tokens` | ✅ Verified | OpenAPI spec, `ResponseResource` schema |
| Usage can be null/missing | ⚠️ Yes | Schema allows null; code falls back to estimates |
| Usage is passed through, not recalculated | ✅ Verified | `stream-adapter.ts`, `usage-tracker.ts` |

### Message Structure

| Property | Available | Usable for Correlation |
|----------|-----------|------------------------|
| `role` (1=User, 2=Assistant, 3=System) | ✅ | ❌ Not unique |
| `name` | ✅ (often empty) | ❌ Read-only for us |
| `content` (text, data, toolCall, toolResult) | ✅ | ✅ Primary material |
| `callId` on tool parts | ✅ | ⚠️ May differ across turns |
| Message-level `id` | ❌ None | N/A |
| Conversation/chat panel ID | ❌ None | N/A |

### Summarization Detection

| Finding | Status |
|---------|--------|
| Detectable via `<conversation-summary>` tag in User message | ✅ Verified |
| Summary contains extractable parent identifier | ❌ No — prose only |
| Message count drops indicate new conversation | ✅ Observable |

## The Correlation Problem

### Message Flow

```
Turn N:
  1. VS Code calls provideLanguageModelChatResponse(messages_N)
  2. We transform messages (extract system prompt, filter empty, convert tools)
  3. We send to OpenResponses, receive usage_N
  4. We stream response back (with URL annotations, formatting)
  5. VS Code stores our formatted response

Turn N+1:
  6. VS Code calls provideLanguageModelChatResponse(messages_N+1)
  7. messages_N+1 includes our formatted response from step 4
```

### The Stability Question

**Can we compute `digest(messages[0..k])` on turn N and get the same result on turn N+1?**

**Risk factors identified:**
- Our output formatting (URL annotations, italics) becomes part of stored messages
- Tool `callId` values in our response may not match what VS Code stores
- We haven't verified VS Code replays messages byte-identically

**Proposed solution:**
Digest messages **on receipt, before any transformation**. This gives us:
- `digest_input`: Hash of what VS Code sent us
- We can verify on next turn if the prefix matches

### Digest Design

```typescript
function digestMessages(messages: LanguageModelChatMessage[]): string {
  // Normalize to stable representation
  const normalized = messages.map(msg => ({
    role: msg.role,
    // Exclude 'name' if unreliable
    content: normalizeContent(msg.content)
  }));
  
  return sha256(JSON.stringify(normalized));
}

function normalizeContent(parts: LanguageModelChatMessageContentPart[]): NormalizedPart[] {
  return parts.map(part => {
    if (isTextPart(part)) {
      return { type: 'text', value: part.value };
    }
    if (isToolCallPart(part)) {
      // Include name and input, but callId may be unstable
      return { type: 'toolCall', name: part.name, input: part.input };
    }
    if (isToolResultPart(part)) {
      return { type: 'toolResult', name: part.name, result: part.toolResult };
    }
    // ... handle other types
  });
}
```

## Storage Model

```typescript
interface TokenRecord {
  inputTokens: number;
  outputTokens: number;
  timestamp: number;
  // Optional: link to parent digest if we detect summarization
  parentDigest?: string;
}

// Memento storage
type TokenStore = Map<string /* digest */, TokenRecord>;
```

**Eviction strategy**: LRU based on `timestamp`. Safe because:
- Equivalent transcripts produce equivalent counts
- If evicted and re-encountered, we just re-record from OpenResponses

## Open Questions

### Q1: Digest Stability Across Turns

**Unknown**: Does VS Code replay messages byte-identically?

**Test needed**: 
1. On turn N, compute digest of `messages[0..k]`
2. On turn N+1, compute digest of `messages[0..k]` (same prefix)
3. Compare — are they equal?

**If not equal**: We need to identify what changes and normalize it out.

### Q2: Our Output in Next Turn

**Unknown**: When we stream a response, how does it appear in `messages_N+1`?

**Specifically**:
- Is our URL annotation formatting preserved?
- Is the tool `callId` we use preserved?
- Are there any VS Code transformations?

### Q3: Parent-Child Linking

**Current state**: We can detect summarization via `<conversation-summary>`, but the summary contains no extractable parent identifier.

**Options**:
1. Accept we can't link parent-child reliably
2. Inject a marker into our responses that survives summarization
3. Use heuristics (e.g., summary text contains distinctive phrases we can match)

**Recommendation**: Defer this. Focus on token counting first.

### Q4: Concurrent Request Handling

**Claim**: Digest-based correlation is safe for concurrent requests because each request has a unique transcript.

**Assumption**: We compute digest before any async operation, so there's no race.

**Verify**: Review code paths to confirm.

## Proposed Implementation Phases

### Phase 1: Verify Digest Stability

Add instrumentation to answer Q1 and Q2:
- Log digest of messages on receipt
- On subsequent turns, log digest of message prefix
- Compare across turns

### Phase 2: Implement Token Store

If digest stability is confirmed:
- Create `TokenStore` backed by Memento
- Record `digest → usage` on each request
- Implement LRU eviction

### Phase 3: Integrate with Status Bar

- On request, compute digest
- Look up stored count (if exists) for instant display
- Update with authoritative count from OpenResponses response

### Phase 4: Summarization Handling (Optional)

- Detect `<conversation-summary>` tag
- Treat as new context (new digest)
- Optionally attempt parent linking (if solution found)

## Alternatives Considered

### Content Injection (Capsules)

**Previous approach**: Inject `<!-- v.cid:xxx aid:yyy -->` into response content.

**Problem**: HTML comments render as visible text in VS Code chat UI. VS Code's markdown renderer doesn't support HTML comments.

**Status**: Abandoned.

### Server-Side Conversation ID

**Idea**: Have OpenResponses return a stable `conversation_id`.

**Findings**: OpenResponses has `previous_response_id` for chaining, but we can't inject this into requests — Copilot controls the request.

**Status**: Not viable without VS Code API changes.

### Message `name` Field

**Idea**: Use the `name` field on messages for identity.

**Findings**: Field exists but we can't set it — Copilot creates assistant messages from our stream.

**Status**: Not viable.

## References

- [OPERATIONAL_CONSTRAINTS.md](../../research/OPERATIONAL_CONSTRAINTS.md) — First-principles constraint analysis
- [RFC 041](../withdrawn/041-capsule-guard-rewrite.md) — Previous capsule approach (withdrawn/superseded)
- OpenResponses OpenAPI spec: `packages/openresponses-client/openapi.json`

## Changelog

- 2026-02-04: Initial draft from research findings
