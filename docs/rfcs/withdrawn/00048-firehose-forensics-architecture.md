---
title: Firehose Forensics Architecture
stage: 0
feature: observability
exo:
    tool: exo rfc create
    protocol: 1
withdrawal_reason: "References removed firehose/forensic capture infrastructure"
---

# RFC 00048: Firehose Forensics Architecture

**Status:** Idea  
**Priority:** Medium  
**Author:** Copilot  
**Created:** 2026-02-05

**Related:** 045 (Rolling Correction - needs this for validation)

## Problem

We have multiple observability streams that don't compose well:

| Stream | Format | Purpose | Problem |
|--------|--------|---------|---------|
| Narrative logs | Prose + structured | Hypothesis formation | Hard to query programmatically |
| Forensic captures | JSONL | Request/response payloads | Missing internal state transitions |
| Debug logs | Text | Debugging | Noisy, unstructured, hard to correlate |

When investigating issues (like RFC 045's token estimation gap), we find ourselves:
1. Unable to correlate events across streams
2. Missing internal state machine transitions
3. Reluctant to trawl through giant log files
4. Building one-off investigation tools that duplicate logic

## Proposal

A single **firehose** event stream with:
1. **Discriminated union types** — every event has a `type` field
2. **Correlation IDs** — `turnId`, `conversationId`, `agentId` on every event
3. **Timestamps** — monotonic, high-resolution
4. **SQLite storage** — queryable, indexed, survives restarts

All other observability tools become **consumers** of this firehose.

## Event Type Examples

```typescript
type FirehoseEvent =
  // Token estimation events
  | {
      type: 'token.provideTokenCount';
      timestamp: number;
      turnId: string;
      conversationId?: string;
      callIndex: number;
      gapSinceLastCall: number;
      isNewSequence: boolean;
      estimate: number;
      adjustmentApplied: number;
      source: 'tiktoken' | 'cached' | 'delta';
    }
  | {
      type: 'token.sequenceComplete';
      timestamp: number;
      turnId: string;
      totalEstimate: number;
      callCount: number;
    }
  | {
      type: 'token.apiActual';
      timestamp: number;
      turnId: string;
      conversationId?: string;
      inputTokens: number;
      outputTokens: number;
      sequenceEstimate: number;
      ratio: number;
    }
  
  // API events
  | {
      type: 'api.request';
      timestamp: number;
      turnId: string;
      conversationId?: string;
      model: string;
      messageCount: number;
      estimatedTokens: number;
    }
  | {
      type: 'api.response';
      timestamp: number;
      turnId: string;
      status: 'success' | 'error';
      inputTokens?: number;
      outputTokens?: number;
      errorCode?: string;
    }
  
  // Agent lifecycle events
  | {
      type: 'agent.start';
      timestamp: number;
      agentId: string;
      parentAgentId?: string;
      agentType: string;
      systemPromptHash: string;
    }
  | {
      type: 'agent.end';
      timestamp: number;
      agentId: string;
      tokenTotal: number;
    }
  
  // Sequence tracker events
  | {
      type: 'sequence.gap';
      timestamp: number;
      gapMs: number;
      previousCallCount: number;
      previousTotal: number;
    }
  | {
      type: 'sequence.newTurn';
      timestamp: number;
      turnId: string;
      previousTurnId?: string;
    };
```

## Storage: SQLite

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL,
  turn_id TEXT,
  conversation_id TEXT,
  agent_id TEXT,
  data JSON NOT NULL
);

CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_turn ON events(turn_id);
CREATE INDEX idx_events_timestamp ON events(timestamp);
CREATE INDEX idx_events_conversation ON events(conversation_id);
```

**Why SQLite over JSONL?**
- Queryable without loading entire file
- Indexes for fast filtering
- JSON functions for nested data
- Can export to JSONL for external tools
- Survives extension restarts

## Migration Path

### Phase 1: Define Types
- Create `FirehoseEvent` discriminated union
- Create `Firehose` class with `emit(event)` method
- SQLite storage with auto-rotation (e.g., 100MB limit)

### Phase 2: Migrate Forensic Capture
- `captureForensicData()` emits `api.request` + `api.response` events
- Keep JSONL export as a consumer of firehose

### Phase 3: Add Token Events
- `provideTokenCount()` emits `token.provideTokenCount`
- `recordActual()` emits `token.apiActual`
- SequenceTracker emits `sequence.gap`, `sequence.newTurn`

### Phase 4: Query Tools
- CLI tool: `pnpm analyze-firehose --type=token.* --turn=abc`
- VS Code command: "Show Token Estimation Timeline"
- Export: `pnpm export-firehose --format=jsonl`

## Relationship to Narrative Logs

Narrative logs remain valuable for **hypothesis formation** — they tell a story.

Firehose is for **hypothesis testing** — it provides the raw data.

The narrative logger could become a firehose consumer that:
1. Subscribes to relevant event types
2. Formats them into prose
3. Maintains the "story" abstraction

## Success Criteria

1. **Single source of truth** — all observability derives from firehose
2. **Queryable** — can answer "show me all token estimates for turn X"
3. **Correlatable** — can join events by `turnId`, `conversationId`
4. **Extensible** — adding new event types is just adding to the union

## Open Questions

1. **Retention policy** — how long to keep events? Size-based? Time-based?
2. **Privacy** — should we hash sensitive data or omit it entirely?
3. **Performance** — is SQLite fast enough for high-frequency events?
4. **Location** — `~/.vscode-ai-gateway/firehose.db` or workspace-local?

## References

- [Forensic Capture](../../packages/vscode-ai-gateway/src/provider/forensic-capture.ts)
- [RFC 045: Rolling Correction](./00045-rolling-correction-for-provide-token-count.md) — needs firehose for validation