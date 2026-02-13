---
title: Logging Alignment: Unify Orthogonal Logging with Investigation Patterns
feature: logging
exo:
    tool: exo rfc create
    protocol: 1
---

# RFC 00067: Logging Alignment — Unify Orthogonal Logging with Investigation Patterns

**Status:** Stage 0 (Idea)
**Created:** 2026-02-12

## Problem

The extension has three orthogonal logging systems that evolved independently:

1. **Narrative logger** (`logger.ts`) — Level-filtered output to VS Code Output Channel + console. Widely used across all runtime modules (extension.ts, provider.ts, openresponses-chat.ts, status-bar.ts, auth.ts, models.ts). Live, unstructured, not scoped per investigation.

2. **Tree diagnostics** (`diagnostics/tree-diagnostics.ts`) — Flight recorder for agent tree state. Logs event payloads + tree snapshots + invariant check results. Uses narrative logger at `debug`/`warn` level. Live-only, no file persistence.

3. **Diagnostic dump command** (`extension.ts`) — On-demand JSON snapshot of full agent state to `.logs/diagnostic-dump-*.json`. User-triggered, not part of any logging system.

The **InvestigationLogger** (`logger/investigation.ts`) is the only persistent, structured logging system — hierarchical per-investigation, per-conversation, per-message file logging with JSONL index, SSE capture, and configurable detail levels.

The problem: when debugging a production issue, you need to correlate across all three systems manually. There is no request ID threading, no shared timeline, and no way to get tree diagnostics into the investigation log.

## Current State (Audit Results)

| System              | Output                      | Persistence     | Scoped      | Structured      |
| ------------------- | --------------------------- | --------------- | ----------- | --------------- |
| Narrative logger    | Output Channel + console    | No              | No          | No              |
| Tree diagnostics    | Output Channel (via logger) | No              | No          | Yes (snapshots) |
| Diagnostic dump     | `.logs/` file               | Yes (on-demand) | No          | Yes (JSON)      |
| InvestigationLogger | `.logs/` directory tree     | Yes             | Per-request | Yes (JSONL)     |

## Proposed Alignment

### Phase 1: Request ID Correlation

Add a `requestId` to narrative logger calls during request lifecycle. This lets you grep the Output Channel for a specific request and correlate with InvestigationLogger files.

- Narrative logger gains optional `requestId` context
- During `openresponses-chat` request lifecycle, pass `requestId` to logger calls
- No file format changes; purely Output Channel improvement

### Phase 2: Tree Diagnostics → Investigation Bridge

When InvestigationLogger is active for a request, tree diagnostic events during that request are also written to the investigation directory.

- Add `InvestigationRequestHandle.recordTreeEvent(event, snapshot)` method
- Tree diagnostics checks for active investigation handle before logging
- Produces `tree-events.jsonl` alongside existing `messages.jsonl` and `.sse.jsonl`

### Phase 3: Diagnostic Dump Integration

When a diagnostic dump is triggered, if there's an active investigation, write the dump into the investigation directory instead of (or in addition to) the top-level `.logs/`.

- Diagnostic dump command checks for active investigation context
- Writes `diagnostic-dump.json` into the investigation directory
- Preserves current standalone behavior as fallback

## Design Principles

1. **Additive, not breaking** — No existing behavior changes. Each phase adds correlation without removing existing output.
2. **Opt-in persistence** — Narrative logger stays live-only by default. Only investigation-scoped calls get persistence.
3. **Single timeline** — All systems share a monotonic timestamp and optional requestId for correlation.
4. **Investigation as gravity well** — When an investigation is active, orthogonal systems can optionally contribute to it.

## Non-Goals

- Replacing the narrative logger (it serves a different purpose: live operational visibility)
- Making tree diagnostics always persistent (only during active investigations)
- Changing InvestigationLogger's file format or directory structure

## Dependencies

- InvestigationLogger infrastructure (already implemented)
- ESLint logging hygiene rules (already implemented)

## Open Questions

1. Should Phase 1 use a structured log format (JSON lines) in the Output Channel, or keep human-readable with `[req:abc123]` prefix?
2. Should tree diagnostic events in Phase 2 use the same JSONL schema as SSE events, or a dedicated schema?
3. Is Phase 3 worth the complexity, given diagnostic dumps are rare and manual?
