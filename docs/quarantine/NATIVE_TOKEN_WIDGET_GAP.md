# Native Token Widget Gap Analysis

**Date**: 2026-02-08  
**Status**: Confirmed architectural limitation — no workaround exists

## Summary

The VS Code chat token usage widget (circular progress indicator in chat input) cannot be
populated by a pure Language Model Provider. This is by design, not an oversight.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ VS Code Core                                           │
│  ChatContextUsageWidget                                │
│    reads: response.usage.promptTokens                  │
│    reads: model.maxInputTokens                         │
│    shows: percentage = promptTokens / maxInputTokens   │
│    detail popup: promptTokenDetails[] categories       │
│                                                        │
│  ChatResponseModel.usage ← set via:                    │
│    MainThreadChatAgents2.setUsage()                    │
│      ← IChatUsageDto { kind: 'usage' }                │
│        ← ExtHostChatAgents2.usage()                   │
│          ← ChatResponseStream.usage() [proposed API]  │
│            ← chatParticipantAdditions gate             │
└─────────────────────────────────────────────────────────┘
              ↑ Only chat participants can call this

┌─────────────────────────────────────────────────────────┐
│ Language Model Provider API                            │
│  Stream parts: text | tool_use | data | thinking       │
│  NO usage part exists                                  │
│  ExtensionContributedChatEndpoint hardcodes:          │
│    usage: { prompt_tokens: 0, completion_tokens: 0 }  │
└─────────────────────────────────────────────────────────┘
```

## Why It Works for Copilot's Built-in Models

Copilot's BYOK providers (Anthropic, Gemini, OpenAI) are **not** pure LM providers.
They live inside `vscode-copilot-chat` and use a privileged internal path:

1. Register as LM providers (for other extensions to use)
2. But Copilot's own chat participant consumes them via `CopilotLanguageModelWrapper`
3. Which routes through direct HTTP endpoints (not the VS Code LM API)
4. Usage flows back through Copilot's `toolCallingLoop`, which calls `stream.usage()`

The `ExtensionContributedChatEndpoint` adapter (which wraps external LM providers like us)
explicitly acknowledges this limitation:

```typescript
// Note: We intentionally don't log chat requests here for external models (BYOK).
// BYOK providers (Anthropic, Gemini, CopilotLanguageModelWrapper) handle their own
// logging with correct token usage. Logging here would create duplicates with
// incorrect (0) token counts since we don't have access to actual usage stats.
```

## Options Evaluated

| Option                                 | Viable?         | Why                                                                                                 |
| -------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------- |
| Pure LM Provider streaming usage       | No              | No usage part type exists in the LM API                                                             |
| LanguageModelDataPart with custom MIME | No              | extChatEndpoint only handles `stateful_marker`, `thinking`, `context_management`                    |
| Build our own chat participant         | Technically yes | Would require reimplementing ALL of Copilot (tool loop, context, edits, agent mode). Not practical. |
| Contribute to VS Code API              | Closed          | microsoft/vscode#279876 "Allow extensions to contribute usage/quota to UI" — closed as not planned  |

## Our Approach

Custom status bar + sidebar tree view that reads token usage directly from our
OpenResponses API responses. This is the only viable path for a pure LM provider.

## References

- VS Code widget: `src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts`
- VS Code usage type: `IChatUsage` in `chatService.ts`
- Proposed API gate: `vscode.proposed.chatParticipantAdditions.d.ts`
- Copilot endpoint adapter: `src/platform/endpoint/vscode-node/extChatEndpoint.ts`
- GitHub issue (closed): https://github.com/microsoft/vscode/issues/279876
