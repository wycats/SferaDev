# Investigation: Token Budget, Tool Overhead, and Summarization Loop

## Goal

Document what we have verified so far about token budgets and tool overhead, plus the remaining variables that likely explain why Vercel models summarize repeatedly while Copilot models do not.

## Key Finding: Tool Set Size Difference

**Verified from source and captures:**

| Metric                | Copilot (package.json) | Vercel Capture |
| --------------------- | ---------------------- | -------------- |
| Tools defined         | 39                     | 55             |
| maxInputTokens        | varies (CAPI metadata) | 128,000        |
| String tokens (tools) | ~unknown               | 15,762         |

The **16 extra tools** in the Vercel capture come from:

- 16 `exo-*` tools (from exo extension)
- 7 `github-pull-request_*` tools (from GitHub PR extension)
- Total: 23 extra, minus some Copilot tools not present = net +16

**Why this matters:** Each tool schema consumes tokens. With 55 tools at ~300 tokens/tool average, that's ~16,500 tokens just for tool definitions. The Vercel capture showed 15,762 string tokens in batch 1, which aligns with tool schema overhead.

## Findings (Verified)

1. **Token budget is NOT the differentiator.** Vercel models report `maxInputTokens = 128000`, same as many Copilot endpoints.

2. **Tool schema leaf tokens dominate counts.** Live capture previews show repeated schema keys (`type`, `description`, `string`, etc.) are the bulk of string tokens.

3. **Token fragmentation overhead is small.** Comparing leaf-sum vs serialized schema is roughly 4% inflation.

4. **Copilot uses `getEnabledTools()` with filtering.** The filter applies:
   - Tool picker selections from `request.tools`
   - Model-specific overrides (e.g., `allowTools` map)
   - Tag-based filtering

5. **Extension-contributed models receive the same tool set from Copilot.** The tools we receive in `options.tools` are chosen by Copilot, not by our extension.

## Source Evidence

- Copilot tool definitions: [.reference/vscode-copilot-chat/package.json](.reference/vscode-copilot-chat/package.json) (`languageModelTools` section, 39 tools)
- Tool filtering logic: [.reference/vscode-copilot-chat/src/extension/tools/vscode-node/toolsService.ts](.reference/vscode-copilot-chat/src/extension/tools/vscode-node/toolsService.ts) (`getEnabledTools`)
- Agent intent tool setup: [.reference/vscode-copilot-chat/src/extension/intents/node/agentIntent.ts](.reference/vscode-copilot-chat/src/extension/intents/node/agentIntent.ts) (`getAgentTools`)
- Extension-contributed endpoint: [.reference/vscode-copilot-chat/src/platform/endpoint/vscode-node/extChatEndpoint.ts](.reference/vscode-copilot-chat/src/platform/endpoint/vscode-node/extChatEndpoint.ts)

## Remaining Hypotheses

### Most Likely: Tool Set Mismatch

Copilot sends more tools when using extension-contributed models because:

- The tool picker defaults may differ
- Extension-contributed tools (exo, github-pull-request) are included by default
- Copilot's own endpoints may have stricter filtering

**Test:** Compare tool snapshots from identical prompts using Copilot endpoint vs Vercel endpoint.

### Possible: Summarization Algorithm Bug

The summarizer produces summaries that still violate limits, so it repeats. This is independent of tool count.

**Test:** Trace summarizer inputs/outputs to see if summary + tools still exceeds cap.

### Less Likely: Hidden Prompt Expansion

Vercel path has additional system prompt content that Copilot doesn't add to its own endpoints.

**Test:** Compare raw prompt payloads (system + history) between endpoints.

## Capture Data (2026-02-09)

Bundle: `/home/wycats/.vscode-ai-gateway/captures/token-debug-1770618187806`

```json
{
  "modelId": "anthropic/claude-opus-4.5",
  "maxInputTokens": 128000,
  "toolCount": 55
}
```

Token counts (batch 1):

- Total: 26,165 tokens
- Strings: 15,762 tokens (tools + misc)
- Messages: 10,403 tokens

## Next Steps

1. **Compare tool sets:** Use the same prompt with Copilot endpoint (GPT-4o) and capture their tool list. Can't capture directly, but can infer from token counts or system prompt references.

2. **Reduce tool count for Vercel:** As a mitigation, filter out exo/github-pull-request tools from the Vercel path to match Copilot's tool count.

3. **Trace summarization:** Add logging to see what the summarizer receives and produces, especially whether the post-summary prompt still exceeds limits.

## Notes

- The capture bundle command logs tool snapshots and token-count calls.
- Bundle includes `maxInputTokens` in metadata for verification.
- Copilot defines 39 tools; extensions add more.
