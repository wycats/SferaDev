---
title: Interface-First API Alignment: Proposed APIs as Design Signals
feature: architecture
exo:
    tool: exo rfc create
    protocol: 1
---

# RFC 00066: Interface-First API Alignment: Proposed APIs as Design Signals

**Status:** Stage 1 (Proposal)
**Created:** 2026-02-12
**Updated:** 2026-02-12
**Related:** RFC 028 (Proposed APIs Strategy)

## Summary

Extract clean interfaces from the extension's current workarounds, using VS Code's proposed API shapes as co-design signals. This produces better abstractions than either the workaround or the proposal alone — and is architecturally decoupled from any decision about when to adopt proposals.

## Insight

Designing interfaces from **both sides simultaneously** — the workaround (which knows real constraints) and the proposed API (which knows the intended shape) — surfaces design questions that neither side reveals alone.

For example: modelling the stateful marker MIME hack as an implementation of `ConversationIdentityProvider` forces us to answer "what happens on first turn?" and "who generates the UUID?" — questions the current code answers implicitly but never documents.

## Proposal Audit Results

Scanned 162 VS Code proposals using `vscode-api-horizon.ts` (v3, stable-API diffing + manual overrides). Filtered to **31 AI-related proposals** across 7 themes. Applied a multi-dimensional decision function (see `scripts/proposal-priority-model.md` for full methodology and graded inventory).

### Decision Function

```
PRIORITY(proposal) =
  if value == integration:
    if timeline <= mid:     → PREPARE NOW (free UX)
    else:                   → WATCH

  if value == correctness:
    if fragility == high:   → PREPARE NOW (carrying risk, not debt)
    if timeline <= near:    → PREPARE NOW
    else:                   → WATCH (debt, not risk)

  if value == feature:
    if entanglement == orthogonal:
      if timeline <= mid:   → EXPERIMENTAL TRACK
      else:                 → WATCH
    if entanglement == core:
      → DESIGN AWARENESS (factor into interfaces, don't adopt)

  if value == streamline:
    if timeline <= near:    → PREPARE NOW (low effort, soon)
    else:                   → IGNORE (not worth the abstraction)
```

### Triage Summary

| Action | Count | Key proposals |
|--------|-------|---------------|
| **PREPARE NOW** | 8 | languageModelSystem, languageModelCapabilities, languageModelThinkingPart, chatParticipantAdditions, chatStatusItem, codeActionAI, mcpToolDefinitions, mcpServerDefinitions |
| **EXPERIMENTAL** | 9 | chatProvider, chatContextProvider, chatPromptFiles, chatTab, remoteCodingAgents, toolProgress, chatHooks, contribLanguageModelToolSets, languageModelToolSupportsModel |
| **DESIGN AWARENESS** | 5 | agentSessionsWorkspace, chatSessionsProvider, chatParticipantPrivate, defaultChatParticipant, languageModelToolResultAudience |
| **WATCH** | 7 | chatReferenceBinaryData, chatReferenceDiagnostic, contribChatEditorInlineGutterMenu, aiTextSearchProvider, aiSettingsSearch, languageModelProxy, chatOutputRenderer |
| **IGNORE** | 2 | inlineCompletionsAdditions, aiRelatedInformation |

### PREPARE NOW — Detail

| Proposal | Value | Current code | What changes |
|----------|-------|-------------|--------------|
| **languageModelSystem** (72) | Correctness (fragile) | `system-prompt.ts`: hardcodes `role=3`, regex heuristics for disguised system prompts ("You are a" etc.) — fragile, wrong for non-English | Stable System role eliminates all heuristics |
| **languageModelCapabilities** (72) | Streamline | `transform.ts`: already sets `imageInput`/`toolCalling` and runtime accepts them | Types catch up to reality. New value: `editToolsHint` |
| **languageModelThinkingPart** (60) | Integration + Correctness (fragile) | `synthetic-parts.ts`: runtime-probes `LanguageModelThinkingPart` without `enabledApiProposals`. Module augmentation in `vscode-thinking.d.ts` | Stable API = native thinking display for free |
| **chatParticipantAdditions** (55) | Integration | No current usage of tool rendering pipeline | Full native tool rendering layer: `ChatToolInvocationPart` (streaming tool UI), terminal/todo/subagent/MCP renderers, question carousels, confirmations, multi-diff viewer, edit application. Also `ChatResultUsage` for native token widget. Critical for v0 tools. |
| **chatStatusItem** (55) | Integration | `status-bar.ts` (1,676 lines) | Complementary: surface summary inside chat panel where users look. Our status bar does far more (agent hierarchy, token breakdowns) |
| **mcpToolDefinitions** (60) | Feature (orthogonal) | None | Static MCP tool manifests. Feb 2026 milestone. |
| **mcpServerDefinitions** (65) | Feature (orthogonal) | None | `McpGateway` + `lm.startMcpGateway`. Could expose AI Gateway as MCP server. |
| **codeActionAI** (75) | Feature (orthogonal) | None | AI-powered code actions. "Explain with Vercel AI" / "Fix with Vercel AI". Low effort, high visibility. |

### DESIGN AWARENESS — Detail

These are core-entangled features. We don't adopt them, but our interfaces must not fight them.

| Proposal | Design signal for our interfaces |
|----------|----------------------------------|
| **agentSessionsWorkspace** (80) | Highest-scoring proposal. Workspace-scoped agent sessions would replace `stateful-marker.ts`. Our `conversationId`/`sessionId` abstractions must be shaped to delegate to this API. |
| **chatSessionsProvider** (55) | Full session persistence API. Our `AgentEntry`/session state model should be compatible with this shape. |
| **chatParticipantPrivate** (55) | Contains `registerLanguageModelProxyProvider`. Our provider architecture should anticipate proxy registration. |
| **defaultChatParticipant** (52) | `ChatTitleProvider`, `ChatSummarizer`. Our summarization workarounds should be structured for replacement by this API. |
| **languageModelToolResultAudience** (55) | `LanguageModelPartAudience` (Assistant/User/Extension). Our `isMetadataMime()` hack should be abstractable to audience-based filtering. |

## Interface Candidates (Revised)

The original RFC proposed 3 interfaces. The audit revealed that the proposal landscape is richer than expected, and two of the three need expanded scope.

### 1. ConversationIdentityProvider

**Current workaround:** `stateful-marker.ts` — encode sessionId in a custom DataPart MIME type, read it back on next turn. Relies on undocumented DataPart persistence behavior.

**Proposed APIs (multiple):**
- `agentSessionsWorkspace` (score 80) — workspace-scoped agent sessions, the real replacement
- `chatSessionsProvider` (score 55) — full session persistence with `ChatSessionItemController`

**Design questions:**

- What happens on first turn (no prior ID)?
- Who generates the UUID — the provider or the caller?
- Is the ID guaranteed stable across VS Code restarts?
- **New:** How does workspace-scoped session identity relate to per-conversation identity? (agentSessionsWorkspace operates at workspace level, our current hack operates per-conversation)
- **New:** Should the interface expose session *persistence* (save/restore) or just session *identity* (get current ID)? chatSessionsProvider suggests the former.

### 2. TokenCountProvider

**Current workaround:** `counter.ts` — ai-tokenizer estimation with heuristic multipliers, delta estimation. `status-bar.ts` displays results in custom UI.

**Proposed APIs (multiple):**
- `chatParticipantAdditions` — `ChatResultUsage` with `promptTokens`, `completionTokens`, `promptTokenDetails[]` (category/label/percentageOfPrompt). This is the native token widget.
- `languageModelCapabilities` — consumer-side `maxInputTokens` (already in stable types on provider side)

**Design questions:**

- Per-message vs. whole-context counting?
- Streaming (partial) vs. complete counts?
- How does delta estimation compose with actual counts?
- **New:** Should the interface produce `ChatResultUsage`-shaped output directly? The native token widget expects `promptTokens`/`completionTokens`/`promptTokenDetails[]` — if our interface produces a different shape, we need a translation layer.
- **New:** `promptTokenDetails` has category/label/percentageOfPrompt — our status bar already tracks similar breakdowns (context management, agent hierarchy). Should the interface unify these?

### 3. ThinkingContentProvider

**Current workaround:** `synthetic-parts.ts` — runtime-probes `LanguageModelThinkingPart` via `VSCodeThinkingPart`, module augmentation in `vscode-thinking.d.ts`. Uses custom DataPart with thinking MIME type as fallback.

**Proposed APIs:**
- `languageModelThinkingPart` — first-class `LanguageModelThinkingPart` in the response stream
- `chatParticipantAdditions` — `ChatResponseThinkingProgressPart` + `ThinkingDelta` for participant-side rendering

**Design questions:**

- Streaming thinking (partial blocks) vs. complete blocks?
- Are thinking blocks always present or opt-in?
- How do thinking blocks interact with token counting?
- **New:** Provider-side vs. participant-side thinking. We emit `LanguageModelThinkingPart` as a provider; `ChatResponseThinkingProgressPart` is for participants consuming our output. Do we need to handle both sides?

### 4. Tool Rendering Layer (New — Future)

**Context:** The v0 team plans to port tools into VS Code `LanguageModelTool` instances. This creates a new interface surface that doesn't exist in the current extension.

**Proposed APIs (cluster):**
- `chatParticipantAdditions` — `ChatToolInvocationPart`, `beginToolInvocation()`/`updateToolInvocation()`, specialized renderers (terminal, todo, subagent, MCP, file list), `ChatResponseQuestionCarouselPart`, `ChatResponseConfirmationPart`, `ChatResponseMultiDiffPart`
- `toolProgress` — `ToolProgressStep` (message + increment progress bars)
- `chatHooks` — `PreToolUse`/`PostToolUse` safety hooks
- `chatOutputRenderer` — custom webview renderers for tool result MIME types

**Design questions:**

- Which v0 tools are candidates for `LanguageModelTool` registration?
- Should tool rendering be part of this RFC or a separate RFC?
- How do tool-specific data types (`ChatTerminalToolInvocationData`, `ChatTodoToolInvocationData`, etc.) map to v0 tool output formats?
- What governance model do `chatHooks` enable for tool execution safety?

**Status:** This is documented as a design signal, not an interface to build in this phase. The v0 tools roadmap will determine timing.

## Non-Goals

- This RFC does NOT decide when to adopt any specific proposal
- This RFC does NOT require switching to VS Code Insiders
- This RFC does NOT change any current behavior
- This RFC does NOT design the v0 tools integration (section 4 is a forward reference)

## Relationship to RFC 028

RFC 028 defines the **two-build strategy** (stable vs. Insiders) and the **runtime feature detection** pattern. This RFC adds the **interface-first design** layer on top — using proposals as design signals to improve the architecture regardless of adoption timeline.

## Artifacts

- `scripts/vscode-api-horizon.ts` — proposal scanner (v3, stable-API diffing + manual overrides)
- `scripts/proposal-priority-model.md` — decision function + full graded inventory of 31 proposals
- `/tmp/full-scan-v3.json` — raw scan data (162 proposals)
- `/tmp/ai-proposal-inventory-v3.json` — filtered AI proposals (31)
