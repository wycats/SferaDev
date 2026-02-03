# Forensic Capture Findings: VS Code LM API Identifiers

## Executive Summary

After comprehensive forensic capture of VS Code Language Model API requests, we have determined:

**VS Code does NOT pass conversation identifiers through the Language Model API.**

The `options.modelOptions` object is consistently **empty** across all captured requests, including:

- Simple single-turn requests
- Multi-turn conversations (3-5 messages)
- Real Copilot requests (143+ messages, 83 tools, 22KB system prompts)

## What VS Code DOES Pass

### 1. Options Object (`LanguageModelChatRequestOptions`)

| Field              | Type     | Description                                                                                          | Useful for Subagent Detection?                  |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `modelOptions`     | `{}`     | **Always empty**                                                                                     | ❌ No                                           |
| `requestInitiator` | `string` | Extension ID making the request (e.g., `github.copilot-chat`, `sferadev.vscode-extension-vercel-ai`) | ⚠️ Partial - identifies extension, not subagent |
| `toolMode`         | `number` | 1=Auto, 2=Required                                                                                   | ❌ No                                           |
| `tools`            | `array`  | Available tools (can have 80+ tools)                                                                 | ⚠️ Partial - tool set might vary by agent       |

### 2. Message Object (`LanguageModelChatMessage`)

| Field  | Type        | Description                   | Useful for Subagent Detection? |
| ------ | ----------- | ----------------------------- | ------------------------------ |
| `role` | `number`    | 1=User, 2=Assistant, 3=System | ❌ No                          |
| `name` | `undefined` | **Always undefined**          | ❌ No                          |
| `c`    | `array`     | Content parts (internal)      | ❌ No                          |

### 3. Model Object (`LanguageModelChatInformation`)

| Field             | Type     | Description                                   |
| ----------------- | -------- | --------------------------------------------- |
| `id`              | `string` | Model identifier (e.g., `openai/gpt-4o-mini`) |
| `name`            | `string` | Human-readable name                           |
| `family`          | `string` | Model family                                  |
| `version`         | `string` | Model version                                 |
| `maxInputTokens`  | `number` | Max input tokens                              |
| `maxOutputTokens` | `number` | Max output tokens                             |
| `capabilities`    | `object` | Model capabilities                            |

### 4. VS Code Environment (`vscode.env`)

| Field       | Type     | Description                       | Useful for Subagent Detection?                |
| ----------- | -------- | --------------------------------- | --------------------------------------------- |
| `sessionId` | `string` | Unique per VS Code window session | ⚠️ Partial - groups requests from same window |
| `machineId` | `string` | Unique per machine                | ❌ No                                         |
| `appName`   | `string` | "Visual Studio Code"              | ❌ No                                         |
| `appHost`   | `string` | "desktop"                         | ❌ No                                         |
| `uiKind`    | `string` | "Desktop"                         | ❌ No                                         |
| `language`  | `string` | "en"                              | ❌ No                                         |

## Key Discovery: `requestInitiator`

The `requestInitiator` field is **not documented in the public API** but is passed to providers. This is an internal VS Code field that identifies which extension is making the request.

**Values observed:**

- `sferadev.vscode-extension-vercel-ai` - Our extension's direct requests
- `github.copilot-chat` - Copilot Chat requests (expected for real Copilot usage)

**Limitation:** This identifies the **extension**, not the **subagent** within Copilot. All Copilot subagents (execute, recon, review, etc.) would have the same `requestInitiator`.

## Subagent Detection Strategy

Since VS Code doesn't provide conversation or subagent identifiers, we must rely on **content-based fingerprinting**:

### 1. System Prompt Fingerprinting (Primary)

- Hash the system prompt content
- Different agents have different system prompts
- Same agent across turns has same system prompt hash

### 2. Tool Set Fingerprinting (Secondary)

- Different agents may have different tool sets
- Tool count and names can help identify agent type

### 3. Message Pattern Analysis (Tertiary)

- Message count patterns
- Content structure patterns

## Raw Data Samples

### Options Object (from test run)

```json
{
  "allKeys": ["modelOptions", "requestInitiator", "toolMode"],
  "fullDump": {
    "modelOptions": {},
    "requestInitiator": "sferadev.vscode-extension-vercel-ai",
    "toolMode": 1
  }
}
```

### Message Object (from test run)

```json
{
  "allKeys": ["c", "role", "name"],
  "role": 1,
  "name": null,
  "extraProps": {
    "name": "[unserializable: undefined]"
  }
}
```

## Recommendations

1. **Do NOT rely on `modelOptions` for conversation tracking** - it's always empty
2. **Use `requestInitiator` for extension-level tracking** - helps distinguish Copilot from other extensions
3. **Implement system prompt fingerprinting** - primary method for subagent detection
4. **Generate our own conversation IDs** - based on system prompt hash + session ID

## Test Infrastructure

The forensic capture system is now fully automated:

- Integration tests run via `@vscode/test-electron`
- Tests can be run headlessly with `xvfb-run`
- Captures are written to `~/.vscode-ai-gateway/forensic-captures.jsonl`
- Raw object dumps capture ALL properties VS Code passes

## Files Modified

- `src/provider/forensic-capture.ts` - Enhanced to capture raw objects
- `src/test/suite/index.ts` - 10 automated tests
- `src/test/runTest.ts` - Test launcher with xvfb support

## Date

2026-02-02 (Forensic capture session)
