# Forensic Capture Results

> **Status**: Fresh document for empirical findings
> **Created**: 2026-02-04
> **Related**: Q5 from OPERATIONAL_CONSTRAINTS.md

## Purpose

This document records **empirical findings** from forensic captures of what Copilot sends to our Language Model Provider. All conclusions must be derived from actual capture data, not assumptions.

## Methodology

1. Enable forensic capture: `vercel.ai.debug.forensicCapture: true`
2. Enable full content: `vercel.ai.debug.forensicCaptureFullContent: true`
3. Clear previous captures before each scenario
4. Execute scenario
5. Analyze capture file at `~/.vscode-ai-gateway/forensic-captures.jsonl`
6. Record findings below with evidence

---

## Scenario 1: Multi-Turn Conversation (209 messages)

**Date**: 2026-02-04T22:36:13.675Z
**Capture file**: `~/.vscode-ai-gateway/forensic-captures.jsonl` (cleared and fresh)

### Raw Observations

Captured a 209-message conversation (this investigation session).

### Message Structure

Every message has exactly 3 keys:

| Key | Type | Description |
|-----|------|-------------|
| `c` | array | Content parts (internal property) |
| `role` | number | 1=User, 2=Assistant, 3=System |
| `name` | string \| undefined | See Q2 findings below |

### Q2 Finding: `name` Field Analysis

**The `name` field exists on ALL messages**, but with different values:

| Pattern | Count | Roles |
|---------|-------|-------|
| `name=""` (empty string) | 94 | User only (role=1) |
| `name=undefined` | 115 | System, User, Assistant |

**Key observation**: Only User messages have `name=""`. Assistant messages always have `name=undefined`.

This suggests Copilot may be setting `name=""` on user messages but not preserving any `name` we set on assistant messages.

### Q3 Finding: Undocumented Properties

**No undocumented properties found.** Only `c`, `role`, `name` exist.

### Options Structure

```
Keys: [tools, modelOptions, requestInitiator, toolMode]
```

### Questions Answered

- [ ] Q1: What survives sanitization? — **Needs full content capture enabled**
- [x] Q2: Does message.name persist? — **Partially: exists but only `""` on User messages**
- [x] Q3: Any undocumented properties? — **No, only c/role/name**

---

## Scenario 3: Subagent Invocation

**Date**: _pending_
**Capture file**: _pending_

### Raw Observations

_To be filled with actual capture data_

### Subagent Detection Signals

_What differs between main agent and subagent calls?_

---

## Scenario 4: Mid-Chat Provider Switch

**Date**: _pending_
**Capture file**: _pending_

### Raw Observations

_To be filled with actual capture data_

### History Preservation

_What history do we receive when user switches to us mid-chat?_

---

## Scenario 5: Summarization Event

**Date**: _pending_
**Capture file**: _pending_

### Raw Observations

_To be filled with actual capture data_

### Summarization Detection

_How can we detect that summarization occurred?_

---

## Summary of Findings

| Question                        | Answer    | Evidence  |
| ------------------------------- | --------- | --------- |
| Q1: What survives sanitization? | _pending_ | _pending_ |
| Q2: Does message.name persist?  | _pending_ | _pending_ |
| Q3: Undocumented properties?    | _pending_ | _pending_ |
| Q4: Summarization detection?    | _pending_ | _pending_ |

---

## Quarantined Previous Findings

Previous findings are quarantined at `packages/vscode-ai-gateway/docs/quarantine/FORENSIC_CAPTURE_FINDINGS-2026-02-04-quarantined.md`. Do not reference them until empirically verified.
