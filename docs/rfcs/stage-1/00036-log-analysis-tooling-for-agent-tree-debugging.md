---
title: Log Analysis Tooling for Agent Tree Debugging
stage: 1
feature: diagnostics
exo:
    tool: exo rfc create
    protocol: 1
---

# RFC 00036: Log Analysis Tooling for Agent Tree Debugging

## Problem Statement

Debugging agent tree issues requires manual correlation between:
1. Our extension logs (AI Gateway output channel)
2. VS Code's Copilot logs (GitHub Copilot Chat output channel)
3. Mental model of what the tree "should" look like

This is error-prone and time-consuming. An AI assistant reviewing logs cannot easily:
- Determine if the tree structure is "correct"
- Correlate our events with VS Code's request IDs
- Identify invariant violations without manual inspection

## Goals

1. Structured log analysis script that AI assistants can invoke
2. Tree snapshots with invariant checks on key events
3. Correlation between our logs and VS Code logs
4. Self-auditable output format

## Non-Goals

1. Real-time monitoring UI
2. Persisting analysis across sessions
3. Automatic bug detection/fixing
4. Modifying existing TreeDiagnostics log format (backward compatible additions only)
5. Integration with VS Code's built-in logging infrastructure

## Existing Infrastructure

This RFC builds on existing code:

| File | Purpose |
|------|---------|
| src/diagnostics/tree-diagnostics.ts | JSON-lines flight recorder to {workspaceRoot}/.logs/tree-diagnostics.log |
| src/identity/tree-invariants.test.ts | Property tests for tree invariants |
| src/identity/claim-registry.ts | Parent-child claim mechanism |
| scripts/analyze-forensic-captures.ts | Pattern for analysis scripts |

## Implementation Status

### Phase 1: Enhanced Tree Snapshots with Invariant Checks ✅ COMPLETE

Implemented snapshot-checkable invariants:
1. singleMainAgent — At most one agent has isMain: true
2. mainAgentExists — If agents exist, exactly one is main
3. allChildrenHaveParent — Every agent with parentConversationHash has a matching parent
4. noOrphanChildren — No agent references a non-existent parent
5. noDuplicateIds — All agent IDs are unique
6. claimsHaveValidParent — All pending claims reference existing agents
7. noExpiredClaims — No claims past expiry

Files modified:
- src/diagnostics/tree-diagnostics.ts — Added InvariantCheckResult, checkInvariants(), context support
- src/diagnostics/tree-diagnostics.test.ts — 8 tests covering all invariants
- src/status-bar.ts — All log() calls now pass vscodeSessionId

### Phase 2: Analysis Script for Log Parsing (TODO)
### Phase 3: Diagnostic Dump Command (TODO)
### Phase 4: VS Code Log Correlation (TODO)

## References

- RFC 00033: Conversation Identity Tracking
- RFC 00034: Persistence Manager
