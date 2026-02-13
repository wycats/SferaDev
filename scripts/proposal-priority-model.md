# Proposed API Priority Model

Companion to [`vscode-api-horizon.ts`](./vscode-api-horizon.ts). The scanner
measures **timeline** (when is it landing?). This document defines the
**value assessment** (what does it buy us?) and the **decision function**
that combines both into an action priority.

## Dimensions

### 1. Value Type

| Type | Definition | Example |
|------|-----------|---------|
| **Integration** | Makes us visible through VS Code's own UI with zero feature work. Free UX. | Token widget reporting, native thinking display, tool progress UI |
| **Correctness** | Fixes bugs or eliminates fragile assumptions. Split into *fragile* (relying on undocumented behavior that could break any release) vs *imprecise* (heuristic that's good enough). | System prompt role detection, stateful-marker DataPart persistence |
| **Feature** | Enables something users would notice that we can't do today (or can only hack around). | Session persistence, chat context providers, MCP gateway |
| **Streamline** | Removes workarounds, simplifies code, reduces maintenance surface. | Replacing manual type-guards with stable types |

### 2. Entanglement

| Level | Definition |
|-------|-----------|
| **Core** | Deeply woven into provider/streaming/translation — adoption requires coordinated changes |
| **Orthogonal** | Can be adopted independently, feature-flag friendly |

For **core-entangled features**, there's a further split:

- **Entangled in code** → wait for stability before adopting
- **Entangled in design** → factor into interface design *now*, even without adopting

### 3. Timeline

From the scanner's readiness score:

| Tier | Score | Horizon |
|------|-------|---------|
| Imminent | 85+ or has `api-finalization` label | 1–2 releases |
| Near | 70–84 | 1–3 months |
| Mid | 55–69 | 3–6 months |
| Long | 40–54 | 6–12 months |
| Indefinite | <40 | No clear path |

## Decision Function

```
PRIORITY(proposal) =

  if value == integration:
    if timeline <= mid:     → PREPARE NOW (free UX)
    else:                   → WATCH

  if value == correctness:
    if fragility == high:   → PREPARE NOW (carrying risk, not just debt)
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

### Action categories

| Action | Meaning |
|--------|---------|
| **PREPARE NOW** | Build the abstraction layer or wire-up so we're ready on day one |
| **EXPERIMENTAL TRACK** | Prototype behind a flag; adopt when stable |
| **DESIGN AWARENESS** | Don't adopt, but ensure our interfaces don't fight it |
| **WATCH** | Track in scanner output, revisit next quarter |
| **IGNORE** | Not worth attention at current timeline |

## Rationale for key rules

**Integration gets its own fast lane.** Integration items are the *only*
category where the user perceives value with zero feature work from us.
Token widget, thinking display, tool progress — these are free UX if we
wire them up.

**Correctness splits on fragility, not annoyance.** A heuristic that's
"good enough" is debt. Relying on undocumented behavior that could break
any release is *risk*. Risk gets priority regardless of timeline.

**Core-entangled features produce "design awareness", not "lower priority".**
You don't need to *adopt* `chatSessionsProvider` today. But if your
interfaces are designed without awareness that session persistence is
coming, you'll build abstractions that fight it later. This is the core
insight of RFC 00066 — using proposals as design signals.

**Streamline stays low priority unless it's landing soon.** Simplifying
code that works is nice but not urgent. If the stable API is months away,
the workaround is fine.
---

## Graded Inventory (2026-02-12)

Scanner version: v3 (stable-API diffing + manual overrides).
Scores from `--no-github` mode (offline). Online scores would be higher
for proposals with milestones/finalization labels.

### PREPARE NOW

These proposals either provide free integration UX, fix fragile correctness
issues, or are landing soon enough that we should be ready.

| Score | Proposal | Value | Rationale |
|-------|----------|-------|-----------|
| 72 | **languageModelSystem** | Correctness (fragile) | We hardcode `role=3` and run regex heuristics to detect disguised system prompts in `system-prompt.ts`. The fallback (`extractDisguisedSystemPrompt`) pattern-matches on "You are a" etc. — fragile and wrong for non-English prompts. Stable System role eliminates all of this. |
| 72 | **languageModelCapabilities** | Streamline | Adds `capabilities: { supportsToolCalling, supportsImageToText, editToolsHint }` to consumer-side `LanguageModelChat`. On the provider side, our `transform.ts` already sets `imageInput`/`toolCalling` and the runtime accepts them — this is types catching up to reality, not a fragile hack. Main new value: `editToolsHint` lets consumers know which edit tools our models prefer. Low urgency but near-term timeline. |
| 60 | **languageModelThinkingPart** | Integration + Correctness (fragile) | We probe for `LanguageModelThinkingPart` at runtime via `VSCodeThinkingPart` in `synthetic-parts.ts` and use module augmentation in `vscode-thinking.d.ts`. Works today but relies on undocumented runtime availability without `enabledApiProposals`. Stable API = native thinking display in chat UI for free. |
| 55 | **chatParticipantAdditions** | Integration | Contains `ChatResultUsage` (`promptTokens`, `completionTokens`, `promptTokenDetails[]`) — this is how token counts show up in VS Code's native token widget. We already track tokens in our custom status bar; wiring up `ChatResultUsage` would make them visible in the standard UI too. Also contains `ChatToolInvocationPart` for native tool-call rendering. |
| 55 | **chatStatusItem** | Integration | `window.createChatStatusItem()` — a small status widget *inside the chat panel* (title + description + detail). Complementary to our status bar, not a replacement — our 1,676-line `status-bar.ts` does far more (agent hierarchy, subagent tracking, context management, token breakdowns). Value: surface a summary line where users are actually looking (the chat view). |
| 60 | **mcpToolDefinitions** | Feature (orthogonal) | Has Feb 2026 milestone. Static MCP tool manifests let us declare tools without starting servers. Orthogonal to core provider — can adopt independently. |
| 65 | **mcpServerDefinitions** | Feature (orthogonal) | `McpGateway` + `lm.startMcpGateway` — register MCP servers programmatically. Pairs with mcpToolDefinitions. We could expose Vercel AI Gateway as an MCP server. |
| 75 | **codeActionAI** | Feature (orthogonal) | AI-powered code actions. Near-term (score 75). Could offer "Explain with Vercel AI" or "Fix with Vercel AI" code actions. Low effort, high visibility. |

### EXPERIMENTAL TRACK

Orthogonal features at mid-term timeline. Prototype behind a flag.

| Score | Proposal | Value | Rationale |
|-------|----------|-------|-----------|
| 65 | **chatProvider** | Feature (orthogonal) | `LanguageModelChatProvider` extensions — `ProvideLanguageModelChatResponseOptions`, `PrepareLanguageModelChatModelOptions`. We already implement `LanguageModelChatProvider`; this extends it with richer options. Worth tracking for capability expansion. |
| 65 | **chatContextProvider** | Feature (orthogonal) | `registerChatWorkspaceContextProvider` etc. — let extensions provide context to chat. We could provide Vercel project context (deployments, env vars) to any chat participant. |
| 65 | **chatPromptFiles** | Feature (orthogonal) | `registerInstructionsProvider`, `registerPromptFileProvider` — custom prompt file formats. Could let users configure Vercel AI behavior via `.prompt` files. |
| 65 | **languageModelToolSupportsModel** | Feature (orthogonal) | `registerToolDefinition` with model-specific tool support. Lets tools declare which models they work with. Useful if we expose model-specific capabilities. |
| 60 | **contribLanguageModelToolSets** | Feature (orthogonal) | Contribution point for tool sets. Package.json declarative tool registration. |
| 60 | **chatTab** | Feature (orthogonal) | `TabInputChat` — programmatic access to chat tabs. Could enable "open chat with Vercel AI" commands. |
| 55 | **remoteCodingAgents** | Feature (orthogonal) | Remote agent infrastructure. Could position Vercel AI as a remote coding agent provider. No exports yet (score 55), but strategically interesting. |

### DESIGN AWARENESS

Core-entangled features. Don't adopt yet, but ensure our interfaces
don't fight them when they land.

| Score | Proposal | Value | Rationale |
|-------|----------|-------|-----------|
| 80 | **agentSessionsWorkspace** | Feature (core) | Workspace-scoped agent sessions. Highest-scoring proposal (80). Our `stateful-marker.ts` hack for conversation identity would be replaced by this. **Design signal**: our `conversationId` / `sessionId` abstractions should be shaped so they can delegate to this API when it lands. |
| 55 | **chatSessionsProvider** | Feature (core) | `ChatSessionsProvider`, `ChatSessionItemController` — full session persistence API. Our status bar tracks sessions manually. **Design signal**: our `AgentEntry` / session state model should be compatible with this shape. |
| 55 | **chatParticipantPrivate** | Feature (core) | `ChatLocation`, `registerLanguageModelProxyProvider`, `ChatParticipantDetectionProvider`. Contains the proxy provider registration we'd need for deeper integration. v13 = actively iterated. **Design signal**: our provider architecture should anticipate proxy registration. |
| 52 | **defaultChatParticipant** | Feature (core) | `ChatTitleProvider`, `ChatSummarizer` — customize chat titles and summarization. We fight summarization today (stripping tools, detecting summarization requests). **Design signal**: our summarization workarounds should be structured so they can be replaced by this API. |
| 55 | **languageModelToolResultAudience** | Streamline (core) | `LanguageModelPartAudience` (Assistant/User/Extension) — lets parts target different audiences. Our `isMetadataMime()` hack for filtering internal DataParts would be replaced by `audience: [Extension]`. **Design signal**: our metadata filtering should be abstractable to audience-based filtering. |

### WATCH

Track in scanner output, revisit next quarter.

| Score | Proposal | Value | Rationale |
|-------|----------|-------|-----------|
| 65 | **chatReferenceBinaryData** | Streamline | `ChatReferenceBinaryData` — binary data in chat references. Minor convenience, our image handling works. |
| 65 | **chatReferenceDiagnostic** | Streamline | `ChatReferenceDiagnostic` — diagnostic references in chat. Not relevant to our core provider role. |
| 65 | **contribChatEditorInlineGutterMenu** | Streamline | Contribution point for inline gutter menu in chat editor. UI chrome, not core. |
| 65 | **aiTextSearchProvider** | Feature (orthogonal) | AI-powered text search. Interesting but not aligned with our value prop (LM provider, not search). |
| 60 | **aiSettingsSearch** | Feature (orthogonal) | AI-powered settings search. Same — search, not our lane. |
| 60 | **chatHooks** | Feature (orthogonal) | Shell command hooks at chat lifecycle points (SessionStart, PreToolUse, etc.). Interesting for power users but niche. |
| 60 | **languageModelProxy** | Streamline | `getModelProxy()` — proxy to Copilot's model endpoint. We provide our own models, so this is irrelevant (we'd be the proxy target, not the consumer). |
| 60 | **toolProgress** | N/A (irrelevant) | `ToolProgressStep` adds progress bars inside tool invocation UI. We're a *provider*, not a tool implementor — we don't register `LanguageModelTool` instances. Tool progress is rendered by VS Code's chat UI for tools that *other* extensions register. |
| 51 | **chatOutputRenderer** | Feature (orthogonal) | Custom output renderers for tool results. Could be useful eventually but 3 TODOs and no consumers. |

### IGNORE

Not worth attention at current timeline.

| Score | Proposal | Value | Rationale |
|-------|----------|-------|-----------|
| 47 | **inlineCompletionsAdditions** | Streamline | Extensions to the inline completions API. We're an LM provider, not a completions provider. The base API was finalized in 2022; these additions are for Copilot's own completions UI. |
| 40 | **aiRelatedInformation** | N/A | Internal-only API for VS Code's NL command palette search. Closed as completed Aug 2023, never intended for external finalization. |

---

### Summary

| Action | Count | Key items |
|--------|-------|-----------|
| **PREPARE NOW** | 8 | languageModelSystem, languageModelCapabilities, languageModelThinkingPart, chatParticipantAdditions (token widget), chatStatusItem, codeActionAI, MCP pair |
| **EXPERIMENTAL** | 7 | chatProvider, chatContextProvider, chatPromptFiles, chatTab, remoteCodingAgents |
| **DESIGN AWARENESS** | 5 | agentSessionsWorkspace, chatSessionsProvider, chatParticipantPrivate, defaultChatParticipant, languageModelToolResultAudience |
| **WATCH** | 9 | chatReferenceBinaryData, chatHooks, languageModelProxy, toolProgress, etc. |
| **IGNORE** | 2 | inlineCompletionsAdditions, aiRelatedInformation |