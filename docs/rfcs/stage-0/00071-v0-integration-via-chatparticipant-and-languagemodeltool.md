---
title: v0 Integration via ChatParticipant and LanguageModelTool
feature: architecture
exo:
  tool: exo rfc create
  protocol: 1
---

# RFC 00071: v0 Integration via ChatParticipant and LanguageModelTool

**Status:** Stage 0 (Idea)
**Created:** 2026-02-13
**Related:** RFC 00066 (Interface-First API Alignment)

## Idea

The v0 team plans to port tools into VS Code `LanguageModelTool` instances. This creates an opportunity to incorporate v0 directly into the AI Gateway extension — but it requires a significant architectural change: registering as a `ChatParticipant`.

Today the extension is a **provider** (`LanguageModelChat`). Becoming a **participant** would unlock a cluster of experimental APIs that are currently inaccessible, and would be the natural integration point for v0 tools.

## What ChatParticipant Unlocks

Registering as a `ChatParticipant` is a prerequisite for:

| API                        | What it enables                                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chatParticipantAdditions` | Tool rendering (`ChatToolInvocationPart`, terminal/todo/subagent renderers), `ChatResultUsage` (native token widget), `ChatResponseThinkingProgressPart` (participant-side thinking), question carousels, confirmations, multi-diff viewer |
| `chatSessionsProvider`     | Full session persistence (`ChatSessionItemProvider`, `ChatSessionItemController`, `ChatSessionContentProvider`) — replaces stateful-marker identity hack                                                                                   |
| `toolProgress`             | `ToolProgressStep` with message + increment progress bars for tool execution                                                                                                                                                               |
| `chatHooks`                | `PreToolUse`/`PostToolUse` safety hooks for tool execution governance                                                                                                                                                                      |
| `chatOutputRenderer`       | Custom webview renderers for tool result MIME types                                                                                                                                                                                        |

## v0 Tool Integration Sketch

### Tool Registration

Each v0 tool becomes a `LanguageModelTool` with:

- A tool definition (name, description, input schema)
- An invocation handler that calls the v0 backend
- A result renderer using `chatParticipantAdditions` specialized renderers

### Candidate v0 Tools

The specific tools to port depend on the v0 roadmap, but the pattern would be:

```
v0 tool → LanguageModelTool registration
v0 tool output → ChatToolInvocationPart rendering
v0 tool progress → ToolProgressStep streaming
v0 tool safety → chatHooks governance
```

### Rendering Pipeline

`chatParticipantAdditions` provides specialized renderers for common tool patterns:

- `ChatTerminalToolInvocationData` — terminal command execution
- `ChatTodoToolInvocationData` — task list management
- `ChatResponseQuestionCarouselPart` — interactive questions
- `ChatResponseConfirmationPart` — user confirmations
- `ChatResponseMultiDiffPart` — file change previews

The mapping from v0 tool output formats to these renderer data types is a key design question.

## Scope and Implications

This is a **big scope increase** relative to the current extension architecture:

1. **Provider → Provider + Participant**: The extension would need dual registration. This affects identity resolution, token reporting, and thinking emission (all three interfaces from RFC 00066).

2. **New code surface**: Tool registration, invocation handling, result rendering, progress streaming, and safety hooks are entirely new capabilities.

3. **Dependency on experimental APIs**: The tool rendering cluster (`chatParticipantAdditions`, `toolProgress`, `chatHooks`) is experimental. Stabilization timeline is uncertain.

4. **Cross-cutting with RFC 00066 interfaces**: All three interfaces designed in RFC 00066 have participant-side implementations that would activate if/when ChatParticipant registration happens. The interfaces are already designed to abstract this — see the implementation maps (RFCs 00068, 00069, 00070).

## Open Questions

- Which v0 tools are candidates for `LanguageModelTool` registration?
- What is the v0 team's timeline for VS Code tool porting?
- Should participant registration be behind a feature flag (Insiders-only)?
- How do tool-specific data types map to v0 tool output formats?
- What governance model do `chatHooks` enable for tool execution safety?
- Does the extension need to be _both_ provider and participant simultaneously, or would it transition fully?

## Relationship to RFC 00066

RFC 00066's interface designs are **already compatible** with this future. Each interface has:

- A current provider-side implementation (works today)
- A future participant-side implementation (activates with ChatParticipant registration)

This RFC captures the _motivation_ for why participant registration might happen. RFC 00066 captures the _architectural readiness_ for it.
