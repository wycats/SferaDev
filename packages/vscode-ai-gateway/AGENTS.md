# Agent Instructions for vscode-ai-gateway

This VS Code extension provides AI models via the Vercel AI Gateway using the OpenResponses wire protocol. It registers as a `vscode.lm` language model provider so that any VS Code chat participant (Copilot, @vercel, etc.) can use Vercel-hosted models.

---

## Architecture Overview

### Activation (extension.ts)

Activation is two-phase for boot speed:

1. **Synchronous stub** — `StubProvider` registers immediately with cached model metadata from `globalState`, so the VS Code model picker has entries before any async work.
2. **Async wiring** — Heavy modules load in parallel, then the real `VercelAIChatModelProvider` replaces the stub.

The wiring connects these subsystems:

| Subsystem             | Entry Point                         | Purpose                                                               |
| --------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| **Provider**          | `src/provider.ts`                   | Language model provider (request building, streaming, token tracking) |
| **Agent Registry**    | `src/agent/registry-impl.ts`        | Tracks active agents and their token state                            |
| **Status Bar**        | `src/status-bar.ts`                 | Glanceable token usage display                                        |
| **Conversation Tree** | `src/agent-tree.ts`                 | TreeView showing conversations, activity logs, subagents              |
| **Inspector**         | `src/inspector/content-provider.ts` | Read-only document provider for inspecting tree nodes                 |
| **Identity**          | `src/identity/`                     | Agent identity resolution (claim registry, hash matching)             |
| **Token Counter**     | `src/tokens/counter.ts`             | Token estimation with model-specific tokenizers                       |
| **Diagnostics**       | `src/diagnostics/`                  | Tree snapshots, invariant checks, change logging                      |
| **Logger**            | `src/logger/`                       | Investigation logging, unified event stream                           |
| **Persistence**       | `src/persistence/`                  | Conversation state storage and migration                              |
| **Conversation**      | `src/conversation/`                 | Conversation data model, tree building, tree items                    |
| **Models**            | `src/models/`                       | Model metadata enrichment, filtering, identity                        |

### Source Layout

```
src/
├── extension.ts              # Activation, wiring
├── provider.ts               # VercelAIChatModelProvider (main LM provider)
├── provider-stub.ts          # StubProvider (boot-speed optimization)
├── status-bar.ts             # TokenStatusBar
├── agent-tree.ts             # ConversationTreeDataProvider (TreeView)
├── logger.ts                 # Output channel logger
├── config.ts                 # ConfigService (settings)
├── auth.ts                   # VercelAIAuthenticationProvider
├── vercel-auth.ts            # Vercel CLI token detection
├── models.ts                 # Model list fetching
├── constants.ts              # Extension IDs, vendor ID
├── title-generator.ts        # Conversation title generation
├── turn-characterizer.ts     # Turn type classification
├── provider/
│   ├── openresponses-chat.ts # HTTP request/response handling
│   ├── request-builder.ts    # Builds OpenResponses request bodies
│   ├── stream-adapter.ts     # SSE → VS Code LanguageModelTextPart
│   ├── system-prompt.ts      # extractSystemPrompt() — system role extraction
│   ├── message-translation.ts# VS Code messages → OpenResponses format
│   ├── error-extraction.ts   # Error parsing from API responses
│   ├── image-utils.ts        # Image content handling
│   ├── usage-tracker.ts      # Per-request token usage tracking
│   ├── tool-history.ts       # Tool call/result history management
│   ├── tool-history-strategy.ts # Strategy for tool history inclusion
│   └── synthetic-parts.ts    # Synthetic stream parts
├── agent/
│   ├── registry.ts           # AgentRegistry interface
│   ├── registry-impl.ts      # AgentRegistryImpl
│   └── types.ts              # AgentEntry, TokenUsage, ContextManagementInfo
├── conversation/
│   ├── types.ts              # Conversation, ActivityLogEntry, Subagent, etc.
│   ├── manager.ts            # ConversationManager
│   ├── build-tree.ts         # buildTree(), groupByUserMessage() — tree construction
│   ├── tree-items.ts         # VS Code TreeItem subclasses
│   └── index.ts              # Re-exports
├── identity/
│   ├── claim-registry.ts     # PendingChildClaim matching (parent→child)
│   ├── hash-utils.ts         # Conversation/agent type hashing
│   └── index.ts              # Re-exports
├── tokens/
│   ├── counter.ts            # TokenCounter — model-aware token estimation
│   ├── display.ts            # Token display formatting
│   └── lru-cache.ts          # LRU cache for tokenizer instances
├── inspector/
│   ├── content-provider.ts   # InspectorContentProvider (virtual documents)
│   ├── render.ts             # Markdown rendering for inspector
│   └── uri.ts                # Inspector URI construction
├── diagnostics/
│   ├── tree-diagnostics.ts   # TreeDiagnostics — snapshots, invariant checks
│   └── tree-change-log.ts    # Tree change JSONL logging
├── logger/
│   ├── investigation.ts      # InvestigationLogger — event bus
│   ├── investigation-events.ts # All 12 event kind interfaces
│   ├── investigation-schemas.ts# Zod schemas for event parsing
│   ├── unified-log-subscriber.ts # Writes events.jsonl
│   ├── registry-event-bridge.ts  # AgentRegistry → event stream bridge
│   ├── tree-change-bridge.ts     # Tree changes → event stream bridge
│   ├── investigation-prune.ts    # Log pruning logic
│   ├── investigation-prune-command.ts # VS Code command for pruning
│   ├── error-capture.ts         # Error log capture
│   ├── error-capture-prune.ts   # Error log pruning
│   └── error-export.ts          # Error log export
├── persistence/
│   ├── manager.ts            # PersistenceManager
│   ├── store.ts              # Storage abstraction
│   ├── stores.ts             # Store implementations
│   ├── migration.ts          # Storage key migration
│   └── types.ts              # Persistence types
├── models/
│   ├── enrichment.ts         # Model metadata enrichment
│   ├── filter.ts             # Model filtering
│   ├── identity.ts           # Model identity resolution
│   ├── transform.ts          # Model data transforms
│   ├── types.ts              # Model types
│   └── vscode-model-id.ts    # VS Code model ID formatting
├── utils/
│   ├── digest.ts             # Content digest computation
│   ├── retry.ts              # Retry logic
│   ├── serialize.ts          # Safe JSON serialization
│   ├── stateful-marker.ts    # Metadata MIME markers
│   └── ulid.ts               # ULID generation for event IDs
└── types/
    └── vscode-thinking.d.ts  # Type declarations for thinking API
```

---

## Critical Knowledge

### System Prompt Extraction

`extractSystemPrompt()` in `src/provider/system-prompt.ts` extracts system prompts from VS Code's proposed System role (role=3). **Do not remove this function.**

Without it:

- System prompts get translated as regular messages
- Claude sees incorrect conversation structure
- Tool calling breaks

### The OpenResponses Wire Protocol

This extension communicates with the Vercel AI Gateway using the **OpenResponses** wire protocol. This is **not** the OpenAI Chat Completions API.

Key differences:

| Aspect            | OpenResponses (correct)                                      | Chat Completions (wrong)                                  |
| ----------------- | ------------------------------------------------------------ | --------------------------------------------------------- |
| Endpoint          | `/v1/responses`                                              | `/v1/chat/completions`                                    |
| User content      | `{ type: "input_text", text: "..." }`                        | `{ role: "user", content: "..." }`                        |
| Assistant content | `{ type: "output_text", text: "..." }`                       | `{ role: "assistant", content: "..." }`                   |
| Tool definition   | Flat: `{ type: "function", name: "...", parameters: {...} }` | Nested: `{ type: "function", function: { name: "..." } }` |

**Mixing up `input_text` vs `output_text` causes HTTP 400 errors.**

When working on the provider:

- **DO** refer to `../../packages/openresponses-client/docs/OPENRESPONSES-SPEC.md`
- **DO** use the OpenAPI schema at `../../packages/openresponses-client/openapi.json`
- **DO** use types from the `openresponses-client` package
- **DO NOT** reference OpenAI Chat Completions documentation
- **DO NOT** reference Vercel AI SDK documentation for wire format

### Token Counting vs. State Persistence

If the status bar shows massive jumps (e.g., 20k→40k) or underestimates by >40%, the cause is almost certainly **state amnesia** — the extension forgot previous conversation state and re-estimated from scratch.

**Do not tune constants in `src/tokens/counter.ts`** for large errors. Instead:

1. Check `AgentRegistry` — are agent entries persisting across turns?
2. Check `recordActual` — is it being called with API-reported token counts?
3. Check conversation identity — is the same conversation being matched?

---

## Conversation Tree (RFC 00073)

The tree view (`vercel.ai.agentTree`) shows conversations as the primary hierarchy:

```
Active Conversations
├── Conversation: "Refactor auth module"  (claude-sonnet-4-20250514)
│   ├── 🧑 "Can you refactor the auth..."
│   │   ├── 🤖 AI Response (1.5k in / 300 out)
│   │   │   └── 🔧 Subagent: execute (2.1k in / 450 out)
│   │   └── 🔧 Tool continuation
│   └── 📦 Compaction: -12k tokens
History
└── Conversation: "Fix build errors"  (idle)
```

Key types in `src/conversation/types.ts`:

- `Conversation` — top-level conversation with token state, activity log, subagents
- `ActivityLogEntry` — union of UserMessage, AIResponse, Compaction, Error, Turn, ToolContinuation
- `Subagent` — nested agent with its own token tracking

Tree construction in `src/conversation/build-tree.ts`:

- `buildTree()` — converts flat activity log into hierarchical tree nodes
- `groupByUserMessage()` — groups responses under their originating user message
- Property-based tests verify 12+ structural invariants

### Inspector

Clicking a tree node opens a read-only markdown document via `InspectorContentProvider`. The inspector renders detailed information about conversations, turns, compaction events, and errors.

---

## Agent Identity System

Agents are identified by conversation hash (derived from VS Code's internal conversation ID). The identity pipeline:

1. **New request arrives** — `VercelAIChatModelProvider.provideLanguageModelResponse2()`
2. **Identity resolution** — Match to existing agent or create new one
3. **Claim matching** — If a parent agent created a "child claim" (via tool call), match the new agent as a subagent
4. **Registry update** — `AgentRegistryImpl` tracks the agent's lifecycle

Key files:

- `src/identity/claim-registry.ts` — Pending child claims with 90-second expiry
- `src/identity/hash-utils.ts` — Deterministic hashing for agent type identification

---

## Unified Event Stream

All observable events flow through `InvestigationLogger` → subscribers → `.logs/{investigation}/events.jsonl`.

### Event Kinds (12)

| Kind                      | Source                 | Data                                               |
| ------------------------- | ---------------------- | -------------------------------------------------- |
| `session.start`           | Extension activation   | Extension version                                  |
| `session.end`             | Extension deactivation | —                                                  |
| `agent.started`           | Registry bridge        | Agent ID, isMain, isResume                         |
| `agent.completed`         | Registry bridge        | Usage (tokens), turn count, summarization detected |
| `agent.errored`           | Registry bridge        | Agent ID                                           |
| `agent.updated`           | Registry bridge        | Update type                                        |
| `agent.removed`           | Registry bridge        | Removal reason                                     |
| `request.index`           | Investigation logger   | Status, model, tokens, duration, isSummarization   |
| `request.message-summary` | Investigation logger   | Per-conversation message summaries                 |
| `request.full`            | Investigation logger   | Full request/response bodies                       |
| `request.sse`             | Investigation logger   | Raw SSE events                                     |
| `tree.change`             | Tree change bridge     | Change event, causedByChatId                       |

### Event Base Fields

Every event has: `kind`, `eventId` (ULID), `ts`, `sessionId`, `conversationId`, `chatId`, optional `parentChatId`, `agentTypeHash`, `causedByChatId`.

### Querying Events

```bash
node scripts/query-events.ts session                    # Overview
node scripts/query-events.ts tail                       # Last 20 events
node scripts/query-events.ts request <chatId>           # Events for a request
node scripts/query-events.ts trace <chatId>             # Causality chain
node scripts/query-events.ts errors                     # All errors
node scripts/query-events.ts conversations              # Conversation list
node scripts/query-events.ts search <text>              # Full-text search
node scripts/query-events.ts kinds                      # Event distribution
```

Filters: `--since 5m`, `--kind agent.errored`, `--conversation <id>`, `--json`, `--investigation <name>`

---

## Debugging Workflow: Shared Perception

The logging infrastructure exists so that you and the user can have a **shared view** of what the extension is doing. When the user describes a problem ("my context window jumped", "the subagent disappeared", "something feels slow"), you should be able to independently verify what happened from the event stream — not guess, not ask for screenshots, not read raw files line by line.

### The Principle

The user sees the UI (status bar, tree view, chat behavior). You see the event stream. Together, you can triangulate what happened. The workflow is:

1. **User describes what they see** — "My token count jumped from 20k to 60k after the last turn"
2. **You query the event stream** — Look at the actual data to confirm or refine their observation
3. **You correlate** — Match what the logs show to what the user described
4. **You explain from evidence** — "I can see that agent.completed at 10:04:02 reported 58k input tokens, and the previous turn was 19k. The request.index shows isSummarization=false, so this wasn't a compaction reset — it looks like the conversation history grew by 39k tokens in one turn, which suggests a large tool result was included."

### When the User Reports a Problem

**Always query the event stream first.** Don't ask the user to describe what they see in more detail until you've looked at the data yourself.

```bash
# Step 1: Get the big picture
node scripts/query-events.ts session

# Step 2: Look for obvious problems
node scripts/query-events.ts errors

# Step 3: Look at recent activity
node scripts/query-events.ts tail --count 30
```

From the session overview, you'll know: how many requests happened, how many errored, whether summarization was triggered, and the total token budget. This is usually enough to orient yourself.

### Tracing a Specific Problem

When the user points to a specific moment ("the third request did something weird"), use the conversation and request commands to zoom in:

```bash
# Find the conversation
node scripts/query-events.ts conversations

# Get all events for that conversation
node scripts/query-events.ts tail --conversation <id>

# If you have a chatId, trace its full causality chain
node scripts/query-events.ts trace <chatId>
```

The `trace` command is especially powerful — it shows you the **cause → effect chain**: which agent.started triggered which tree.changes, which request.index recorded the result. This lets you reconstruct the sequence of events that led to what the user observed.

### Connecting User Language to Event Data

Users describe problems in UI terms. Here's how to translate:

| User says                         | Query                  | What to look for                                                                                     |
| --------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------- |
| "My context jumped"               | `tail --count 10`      | `request.index` events — compare `actualInputTokens` across consecutive requests                     |
| "The subagent disappeared"        | `search removed`       | `agent.removed` events — check the `reason` field                                                    |
| "Something got summarized"        | `search summarization` | `agent.completed` with `summarizationDetected=true`, or `request.index` with `isSummarization=true`  |
| "It's making duplicate requests"  | `kinds` then `tail`    | Multiple `agent.started` events with similar timing — check if identity matching failed              |
| "The tree looks wrong"            | `search tree.change`   | `tree.change` events — check `causedByChatId` to see what triggered each change                      |
| "It errored but I didn't see why" | `errors`               | `agent.errored` events, then `request <chatId>` for the full request context                         |
| "It feels slow"                   | `session`              | Check `durationMs` in `request.index` entries — are individual requests slow, or is there a pattern? |

### Investigation Detail Levels

The event stream's richness depends on the `vercel.ai.investigation.detail` setting:

| Level      | What's captured                                 | When to use                 |
| ---------- | ----------------------------------------------- | --------------------------- |
| `off`      | Agent lifecycle + tree changes only             | Normal operation            |
| `index`    | + One-line-per-request (timing, tokens, status) | Lightweight monitoring      |
| `messages` | + Full message summaries per conversation       | Debugging conversation flow |
| `full`     | + Raw SSE event streams                         | Deep protocol debugging     |

When a user reports a problem, if the detail level was `off`, you'll only have agent lifecycle events. You can still diagnose many issues from those, but for token-level problems, suggest they set `vercel.ai.investigation.detail` to `index` and reproduce.

### Tree Diagnostics

`TreeDiagnostics` (`src/diagnostics/tree-diagnostics.ts`) provides a complementary view — snapshots of the agent tree state at each change:

- **Snapshots**: agents with full token state, pending claims, tree text visualization
- **Invariant checks**: exactly one main agent, no orphan subagents, valid parent references
- **Tree text**: human-readable ASCII tree for logging

These are logged on every tree change via `status-bar.ts`. Use the `vercel.ai.dumpDiagnostics` command to write a full diagnostic dump to `.logs/`.

### Common Issues

| Symptom                | Query                           | Likely Cause                                                                        |
| ---------------------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| Subagent at root level | `search parentConversationHash` | Claim not created or expired (90s timeout)                                          |
| Wrong percentage       | `request <chatId> --json`       | `maxInputTokens` not set — model info not enriched                                  |
| Agent stuck streaming  | `tail --kind agent.started`     | No matching `agent.completed` — completion event lost                               |
| Duplicate agents       | `conversations`                 | Same conversation appearing twice — identity matching failure                       |
| Token jumps >40%       | `tail --count 5`                | Compare consecutive `request.index` tokens — state amnesia (see Critical Knowledge) |

---

## Testing

- **Framework**: Vitest (706 tests, 48 files)
- **Convention**: Colocated — `foo.ts` has `foo.test.ts` in the same directory
- **Property-based tests**: `fast-check` for tree invariants, message translation, identity
- **Integration tests**: `*.integration.test.ts` files (request builder, identity pipeline)
- **Run**: `pnpm test` (from `packages/vscode-ai-gateway/`)

---

## Configuration (package.json contributes)

| Setting                           | Default                        | Purpose                                              |
| --------------------------------- | ------------------------------ | ---------------------------------------------------- |
| `vercel.ai.endpoint`              | `https://ai-gateway.vercel.sh` | Gateway endpoint URL                                 |
| `vercel.ai.models.default`        | `""`                           | Default model ID                                     |
| `vercel.ai.logging.level`         | `"warn"`                       | Output channel verbosity                             |
| `vercel.ai.models.userSelectable` | `false`                        | Show all models in picker                            |
| `vercel.ai.investigation.name`    | `"default"`                    | Investigation scope name                             |
| `vercel.ai.investigation.detail`  | `"off"`                        | Investigation detail level (off/index/messages/full) |

### Commands

| Command                                | Purpose                                 |
| -------------------------------------- | --------------------------------------- |
| `vercel.ai.manage`                     | Manage authentication                   |
| `vercel.ai.showTokenDetails`           | Show token usage details                |
| `vercel.ai.refreshAgentTree`           | Refresh agent tree view                 |
| `vercel.ai.inspectNode`                | Inspect a tree node                     |
| `vercel.ai.dumpDiagnostics`            | Dump agent tree diagnostics to `.logs/` |
| `vercel.ai.testSummarizationDetection` | Test summarization detection            |
| `vercel.ai.investigation.prune`        | Prune investigation logs                |
| `vercel.ai.exportErrorLogs`            | Export error logs                       |
| `vercel.ai.refreshModels`              | Refresh model list                      |

---

## External References

### Internal Documentation

- [OpenResponses Spec Summary](../../packages/openresponses-client/docs/OPENRESPONSES-SPEC.md)
- [OpenAPI Schema](../../packages/openresponses-client/openapi.json)
- [Client Package](../../packages/openresponses-client/README.md)

### External

- **OpenResponses**: https://www.openresponses.org
- **OpenResponses Reference**: https://www.openresponses.org/reference
- **OpenResponses Specification**: https://www.openresponses.org/specification
