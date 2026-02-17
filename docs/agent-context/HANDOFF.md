# Agent Handoff Document

> **Purpose**: This document captures context that a fresh agent needs to
> quickly rebuild understanding of the project state, design philosophy, and
> active work. Read this first, then follow the pointers.

## Quick Orientation

This is a VS Code extension that provides AI models via the Vercel AI Gateway.
It registers as a `vscode.lm` language model provider. The codebase is in
`packages/vscode-ai-gateway/`.

**Start here**:

- `packages/vscode-ai-gateway/AGENTS.md` — full architecture, event stream, debugging workflow
- `exo status` — current phase, goals, what's done and what's next
- `exo task list` — tasks within the current goal

## Active Work

### Current Phase: Collaborative UI Refinements

**Epoch**: Conversation-Centric Agent Tree (RFC 00073)

We're implementing RFC 00075 (Shared Perception). The goal is to make the
unified event stream (`events.jsonl`) rich enough that an agent can reconstruct
what the user sees in the VS Code agent tree view — without ever reading files
directly.

**Goal 1 (verify-events-jsonl)**: COMPLETE. Extracted `EventWriter` + `LogConfig`
interfaces, rewrote tests with interface helpers, verified events.jsonl works
end-to-end.

**Goals 2-10**: Not yet started. Read RFC 00075 for the full design. In order:

1. Define `TreeChangeOp` discriminated union types
2. Emit `tree.snapshot` events at session boundaries
3. `TreeChangeLogger` emits typed ops directly (no bridge)
4. Remove standalone `tree-changes.jsonl` file writing
5. Remove `tree-change-bridge.ts` indirection
6. Add CLI `tree` command (reconstruct from events)
7. Add CLI `conversation` command
8. Fork detection in provider
9. Make all CLI outputs self-describing

Each goal should be broken into tasks before starting. Use the PER
(Prepare → Execute → Review) cycle for non-trivial goals.

### Queued Phase: Persistence & Idle Timer

After the current phase. Adds conversation state persistence across VS Code
reloads and an idle timer for conversation lifecycle management.

## Design Principles (User Preferences)

These emerged through dialogue and are non-negotiable:

1. **"Consolidate, don't add ad-hoc"** — When something isn't working, fix the
   existing system. Don't bolt on a new one.

2. **"The CLI is the API"** — Agents should do everything through CLI commands
   and never read files directly. Every CLI output should be self-describing
   (include commands to run for more detail). Every ID in output should be a
   valid argument to another command.

3. **"JIT interface migration"** — Don't go on a mock-elimination crusade.
   When you touch a file with behavioral mocks, extract an interface and
   convert. When you create a new file, use interfaces from the start.
   See `.github/instructions/testing.instructions.md` for the full policy
   and current mock counts.

4. **"No new behavioral mocks"** — Hard rule. New test files must use
   interfaces and test helpers, not `vi.mock()` with assertions.

5. **"Edits = forks"** — When a user edits a message in VS Code chat, the
   extension should detect this as a fork (message history changed), emit a
   `conversation-forked` event, and reset the activity log to the fork point.

6. **The shared perception test** — "I'll feel like we're starting to succeed
   if you can look at the logs and predict what I'm seeing in the agent tree."
   This is the north star for the event stream work.

## Key Files for Active Work

| File                                                | Role                                                                                      |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/logger/unified-log-subscriber.ts`              | Writes events.jsonl. Has `EventWriter` + `LogConfig` interfaces.                          |
| `src/logger/unified-log-subscriber.test-helpers.ts` | `TestEventWriter`, `testLogConfig()`, `testEvent()`                                       |
| `src/logger/investigation-events.ts`                | Event type definitions (12 kinds). Will grow with `TreeChangeOp`.                         |
| `src/diagnostics/tree-change-log.ts`                | 590 lines. Diff detection + file I/O + bridge. To be consolidated.                        |
| `src/logger/tree-change-bridge.ts`                  | Translates tree changes → events. To be DELETED (unnecessary indirection).                |
| `src/provider.ts`                                   | Lines 260-310: `provideLanguageModelChatResponse`. Fork detection goes here.              |
| `src/conversation/types.ts`                         | `Conversation`, `ActivityLogEntry`, `Subagent` types.                                     |
| `packages/agent-cli/src/query-events.ts`            | CLI tool (@vercel/agent-cli). Observation commands: session, tail, perception, tree, etc. |

## Key Decisions Already Made

- **events.jsonl IS working** — verified 2026-02-16. The subscriber writes to
  `.logs/{investigation}/events.jsonl`. The earlier investigation found it
  wasn't working in a different workspace (the parent `exo2/` repo) but it
  works fine when the extension's workspace has folders configured.

- **Stale logs and investigation docs were deleted** — 4.3 GB of stale log
  files and outdated investigation documents (`docs/investigation/`) were
  removed. They're in git history if raw data is ever needed, but their
  conclusions reflected an earlier architecture and would actively mislead.

- **Event sourcing over full snapshots** — RFC 00075 chose deltas (`tree.change`
  with typed `op`) + periodic rollup snapshots (`tree.snapshot`) over the
  previous approach of writing full tree snapshots on every change (which
  produced 982 MB).

- **Fork detection scope** — Detects when `chatMessages.length < prevContext.lastMessageCount`
  or when message hashes don't match. Emits `conversation-forked` op.

## Repository Notes

- **Branch**: `feat/token-status-bar` (historical name, covers all recent work)
- **Test count**: 713 tests, 48 files (as of 2026-02-16)
- **Node.js 24+**: Required for running TypeScript natively (`node packages/agent-cli/src/query-events.ts`)
- **Build**: `pnpm run build` (esbuild), `pnpm run test` (vitest), `pnpm run tsc` (type-check)
- **Install**: Use the "Build and Install Extension" VS Code task

## What to Read Next

1. `exo status` — see where we are
2. `packages/vscode-ai-gateway/AGENTS.md` — full architecture reference
3. `docs/rfcs/stage-2/00075-shared-perception-event-sourced-tree-and-cli.md` — the active RFC (stage-2: detailed spec)
4. `.github/instructions/testing.instructions.md` — mock reduction policy
5. `exo task list` — current tasks (if any are in progress)
