# What VS Code Is Cooking for AI Extensions

*Based on automated scanning of 162 proposed APIs, git activity, GitHub milestones, and the February 2026 iteration plan. Generated February 2026.*

---

## The Big Picture

VS Code's proposed API surface tells a clear story: Microsoft is systematically building out a **full-stack AI extension platform**. Not just "let extensions call an LLM" — they're constructing the infrastructure for extensions to participate in every layer of the AI experience, from model access and tool orchestration to agent lifecycle management and MCP interoperability.

Of 162 total proposed APIs, **28 are AI-related** — and they cluster into five coherent themes that are maturing at different rates.

---

## Theme 1: Language Model Access Is Nearly Complete

**Timeline: Imminent (weeks)**

The Language Model API (`vscode.lm`) shipped its core in 2024: `lm.selectChatModels()`, `sendRequest()`, tool calling. What's left is filling in the gaps that real-world extension authors keep hitting.

**`languageModelSystem` (score 100, finalizing February 2026)** is the most imminent change. Extensions currently can't send system prompts through the LM API — a serious limitation for anything beyond simple Q&A. This adds `LanguageModelChatMessageRole.System`. It's 18 lines of code and has a finalization issue milestoned for this month. The only design question is whether it ships as a role enum value or as `LanguageModelChatRequestOptions.system` (since Anthropic's API doesn't have a system role — it treats system prompts as a separate parameter).

Behind it, a cluster of LM proposals at score 55-60 fill out the rest of the model interaction surface:

- **`languageModelCapabilities` (57)** — Query what a model can do (`supportsToolCalling`, `supportsImageToText`, `editToolsHint`). Extensions currently hard-code model names to know what's supported; this makes it declarative.

- **`languageModelThinkingPart` (55)** — Thinking/reasoning tokens in the response stream. As models like Claude and o-series emit chain-of-thought, extensions need to handle it. This adds `LanguageModelThinkingPart` to the response stream alongside text and tool-call parts, with support for preserving thinking chains across multi-turn conversations via `LanguageModelChatMessage2`.

- **`languageModelToolResultAudience` (55)** — Route tool result parts to different audiences: the model, the user, or the extension's internal state. Today, everything a tool returns goes to the model. This lets you include a rendered preview for the user and raw data for the model in the same result.

- **`languageModelProxy` (55)** — A local HTTP proxy that passes the editor's authenticated Copilot connection to external processes. `lm.getModelProxy()` returns a URI and key that you can hand to a CLI tool, language server, or subprocess. This bridges the gap between VS Code's in-process LM API and the external process reality.

- **`languageModelToolSupportsModel` (60)** — Dynamic tool registration with model selectors. Today, tools are statically declared in `package.json`. This lets you register tools at runtime and scope them to specific models — critical for MCP servers that expose different tools depending on which model is driving the conversation.

None of these are finalizing yet, but they represent a complete vision: extensions should be able to query model capabilities, stream structured responses (including thinking), route results to the right audience, register tools dynamically, and bridge access to external processes.

---

## Theme 2: MCP Integration Is Being Built in Real-Time

**Timeline: Near-term (1-3 months)**

VS Code is building first-class MCP (Model Context Protocol) support, and two proposals in the February 2026 iteration plan show the direction:

**`mcpServerDefinitions` (score 80, in iteration plan)** is the foundational piece. It exposes `lm.mcpServerDefinitions` — a live-updating list of all MCP servers known to the editor (from `mcp.json` files, extension contributions, etc.). More importantly, it adds `lm.startMcpGateway()`, which spins up a localhost HTTP endpoint that external processes can connect to. This means a CLI agent loop can talk to the editor's MCP servers without any custom protocol bridging. The gateway is reference-counted and auto-tears-down when the last consumer disposes it.

**`mcpToolDefinitions` (score 50)** tackles the cold-start problem. Currently, VS Code has to *start* an MCP server to discover its tools. This proposal lets extensions eagerly provide a static manifest of tool metadata — names, descriptions, availability conditions — without starting the server. The `McpToolAvailability` enum controls when tools become callable.

Together, these two proposals paint a picture: VS Code wants to be an MCP hub where extensions both provide and consume MCP servers, servers can be discovered without starting them, and external processes can connect through a managed gateway.

---

## Theme 3: The Chat Experience Is Getting Extension Hooks at Every Layer

**Timeline: Near-term to mid-term (1-6 months)**

The chat proposals are the most numerous (12 of 28) and span from near-finalization to early experimentation.

**Active work (near-term):**

- **`chatPromptFiles` (80, in iteration plan)** — The `.prompt.md` / `.agent.md` / `.instructions.md` system. Extensions register `ChatResource` providers that the chat UI discovers and surfaces. This is how custom agent instructions get into the chat without users manually @-mentioning files.

- **`chatContextProvider` (75, milestoned Feb 2026)** — Workspace context that's automatically included in all chat requests. If your extension understands the project structure (a framework, a monorepo layout, a domain model), you can inject that understanding into every chat turn without the user explicitly attaching it. Supports global workspace context and per-resource context.

- **`chatHooks` (70, milestoned Feb 2026)** — Lifecycle hooks for chat sessions, configured via `hooks.json` files in the workspace. Extensions can intercept eight different moments: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `SubagentStart`, `SubagentStop`, `Stop`. Hooks run as commands that receive JSON input on stdin and return flow-control results (success, blocking error, or non-blocking warning). This is how projects enforce coding standards, security policies, or workflow constraints on AI agents. The `PreCompact` hook is particularly interesting — it fires before context window compaction, letting extensions influence what gets preserved.

- **`chatProvider` (70, milestoned Feb 2026)** — The provider side of the LM API. If you're *hosting* a model (not just consuming one), this is how you register it. `ProvideLanguageModelChatResponseOptions` gives providers visibility into which extension initiated the request. `LanguageModelChatInformation` includes quota multipliers, authorization gating, model picker categories, and the `editToolsHint` capability for declaring which editing strategies the model prefers (find-replace, apply-patch, code-rewrite, etc.).

**Mid-term stabilization:**

- **`chatStatusItem` (55)** — Status indicators in the chat panel (e.g., "Indexing workspace...").
- **`chatTab` (55)** — `TabInputChat` for detecting when a tab is a chat panel.
- **`chatReferenceBinaryData` (60)** — Attach images and binary files as chat references.
- **`chatReferenceDiagnostic` (60)** — Attach Problems panel diagnostics to chat messages.
- **`chatOutputRenderer` (46)** — Custom rich widgets in chat responses (opaque binary blobs rendered by extension-contributed renderers).

**The grab-bags (experimental, indefinite):**

- **`chatParticipantAdditions` (32)** — 1069 lines of experimental chat participant APIs. Currently being used for subagent rendering. This is where features incubate before being extracted into standalone proposals.
- **`chatParticipantPrivate` (49)** — Internal-only APIs (v12) for first-party extensions like Copilot Chat. Hooks like `transcript_path`. These may never become public.
- **`chatSessionsProvider` (32)** — Chat session/history management. 552 lines, 6 TODO comments, heavy iteration.
- **`defaultChatParticipant` (47)** — Default participant customization: welcome messages, title providers, summarizers.

The chat story is one of progressive layering: the core chat participant API is stable, and now Microsoft is adding context injection, lifecycle hooks, and rich media support around it. The grab-bags show what's coming next — session management, subagent orchestration, and custom rendering — but those are still moving targets.

---

## Theme 4: Agent Infrastructure Is Emerging

**Timeline: Mid-term (3-6 months)**

Several proposals signal that VS Code is preparing for a world where AI agents are first-class citizens, not just chat participants.

- **`agentSessionsWorkspace` (65)** — `workspace.isAgentSessionsWorkspace` detects whether the window is a dedicated agent workspace. This is the API surface for Copilot Workspace-style experiences where the entire VS Code window is an agent session.

- **`remoteCodingAgents` (55)** — A placeholder contribution point (@joshspicer) for remote coding agents. The file is empty today — just a comment and an author tag — but its existence in the proposal registry signals intent. This is likely how cloud-based coding agents (Copilot Agents, Devin-style systems) will integrate with VS Code.

- **`chatHooks`** (discussed above) — The hook types `SubagentStart` and `SubagentStop` explicitly model multi-agent orchestration. Extensions can observe and control when subagents are spawned and terminated.

- **`toolProgress` (55)** — `ToolProgressStep` streams progress updates during `LanguageModelTool.invoke()`. When an agent is executing a multi-step tool (running tests, deploying, analyzing), this lets the UI show incremental progress rather than a spinner.

The agent infrastructure is still early — `remoteCodingAgents` is literally an empty file — but the surrounding pieces (session workspaces, subagent hooks, tool progress) are filling in around it.

---

## Theme 5: AI-Augmented Editor Features

**Timeline: Mid-term (3-6 months)**

A smaller cluster of proposals extends VS Code's core editor features with AI capabilities:

- **`aiTextSearchProvider` (60)** — Semantic search in the workspace. Results appear as "{AI Name} Results" in the Search view alongside traditional text matches. This is how extensions like Copilot add "search by meaning" to the existing search UI.

- **`aiSettingsSearch` (60)** — AI-powered settings discovery. When a user searches settings with natural language ("make the font bigger"), a `SettingsSearchProvider` can rank results by semantic relevance rather than keyword matching.

- **`aiRelatedInformation` (52)** — Given a context, find semantically related commands, settings, and other items. A building block for "intelligent suggestions" throughout the UI.

- **`codeActionAI` (60)** — A simple but important flag: `CodeAction.isAI = true` marks a quick fix or refactoring as AI-powered. This affects how VS Code presents it in the lightbulb menu — likely with different visuals, ordering, or telemetry.

- **`inlineCompletionsAdditions` (42, grab-bag)** — Extensions to ghost text / inline completions. Recent work on "change hints" — telling the completion provider what kind of edit the user is making (typing, deleting, refactoring) so it can tailor suggestions. This is how Copilot's inline completions get smarter about context.

- **`contribChatEditorInlineGutterMenu` (65)** — The gutter menu that appears when chat applies inline edits. A contribution point so extensions can add actions alongside the built-in accept/reject buttons.

---

## What This Means for Extension Authors

**Right now (February 2026):**
- `languageModelSystem` will finalize this month. If you're using the LM API, you'll soon be able to send system prompts.
- MCP integration (`mcpServerDefinitions`) and prompt files (`chatPromptFiles`) are in the iteration plan and actively landing.

**Over the next 1-3 months:**
- Chat hooks will give extensions lifecycle control over agent sessions.
- MCP will become a first-class protocol with gateway support for external processes.
- The chat provider API will stabilize, making it possible for third-party extensions to register their own models.

**Over the next 3-6 months:**
- Model capabilities, thinking tokens, and audience-targeted tool results will make the LM API more expressive.
- Agent session infrastructure will formalize the multi-agent patterns currently being prototyped in the grab-bag proposals.
- AI-augmented search, settings, and code actions will start stabilizing.

**The long game:**
The grab-bag proposals (`chatParticipantAdditions`, `chatSessionsProvider`, `inlineCompletionsAdditions`) are where the real future lives — subagent orchestration, session management, custom chat rendering. These are too volatile to finalize now, but the direction is clear: VS Code is building toward a world where AI extensions don't just respond to chat messages, they participate in a managed agent ecosystem with lifecycle hooks, progress reporting, context injection, and MCP interoperability.

---

*Data source: Automated scan of `microsoft/vscode` proposed API files, git activity (30-day window), GitHub milestones, api-finalization labels, and February 2026 iteration plan (api-proposal issues). Scores represent a composite readiness signal, not a quality judgment.*
