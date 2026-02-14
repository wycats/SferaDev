# Vercel AI Gateway — VS Code Extension

Use [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) models (GPT-4o, Claude, Gemini, and more) directly in VS Code's native chat interface.

## Quick Start

### 1. Install the Extension

```sh
# From the repo root
cd packages/vscode-ai-gateway
pnpm package
code --install-extension vscode-ai-gateway-*.vsix --force
```

Or use the VS Code task **Build and Install Extension** (`Ctrl+Shift+B`).

### 2. Authenticate

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run:

> **Vercel AI Gateway: Manage Authentication**

Two methods are available:

| Method | When to use |
|--------|-------------|
| **API Key** | Enter a Vercel AI Gateway API key manually |
| **Vercel OIDC** | Automatic — available when the Vercel CLI is logged in (`vercel whoami`) |

### 3. Start Chatting

Open VS Code's Chat panel (`Ctrl+Shift+I` / `Cmd+Shift+I`). Select a **Vercel AI** model from the model picker and start a conversation.

> **Tip:** Set `vercel.ai.models.userSelectable` to `true` in settings to make all models immediately visible in the picker without using "Manage Models" first.

## Features

- **Multiple AI Models** — Access all Vercel AI Gateway models (GPT-4o, Claude, Gemini, etc.)
- **Native Integration** — Works with VS Code's built-in chat and Copilot
- **Streaming Responses** — Real-time streaming via the [OpenResponses](https://www.openresponses.org) wire protocol
- **Tool Calling** — Full support for VS Code tool integration
- **Token Tracking** — Status bar counter and Agent Tree sidebar for per-conversation token usage
- **Retry Resilience** — Automatic retry with exponential backoff for transient errors
- **Instant Activation** — Stub provider serves cached models immediately on startup

## Configuration

All settings are under `vercel.ai.*` in VS Code Settings.

| Setting | Default | Description |
|---------|---------|-------------|
| `vercel.ai.endpoint` | `https://ai-gateway.vercel.sh` | AI Gateway endpoint URL. Change for self-hosted or regional deployments. |
| `vercel.ai.models.default` | *(empty)* | Default model ID (e.g. `anthropic/claude-sonnet-4-20250514`). Leave empty to show the model picker. |
| `vercel.ai.models.userSelectable` | `false` | Make all models visible in the picker by default. Enable for testing or if you want all models immediately available. |
| `vercel.ai.logging.level` | `warn` | Logging verbosity: `off`, `error`, `warn`, `info`, `debug`, `trace`. |
| `vercel.ai.investigation.name` | `default` | Investigation scope name. Detailed logs are captured to `.logs/{name}/`. |
| `vercel.ai.investigation.detail` | `off` | Investigation detail: `off`, `index`, `messages`, `full`. At `messages`+ levels, full request/response bodies are captured. |

## Commands

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and type "Vercel AI Gateway" to see all commands:

| Command | Description |
|---------|-------------|
| **Manage Authentication** | Add, switch, or remove authentication sessions |
| **Refresh Models** | Force-refresh the model list from the gateway |
| **Show Token Usage Details** | Show detailed token usage for the current session |
| **Refresh Agent Tree** | Refresh the Agent Tokens sidebar |
| **Export Error Logs** | Export captured error logs for debugging |
| **Dump Agent Tree Diagnostics** | Write agent tree state to diagnostics log |
| **Prune Investigation Logs** | Clean up old investigation log files |
| **Test Summarization Detection** | Diagnostic: test summarization boundary detection |

## Troubleshooting

### "No models available"

1. Check authentication: run **Manage Authentication** and verify a session is active.
2. Check the endpoint: ensure `vercel.ai.endpoint` is reachable.
3. Run **Refresh Models** to force a fresh fetch.
4. Check the Output panel (`Vercel AI Gateway`) for error details.

### Authentication fails

- **API Key**: Verify the key is valid and has gateway access.
- **OIDC**: Ensure the Vercel CLI is logged in (`vercel whoami`). OIDC tokens auto-refresh but require an active CLI session.

### Models don't appear in the picker

By default, models are hidden until enabled via **Manage Models** in the chat model dropdown. Set `vercel.ai.models.userSelectable` to `true` to make all models immediately visible.

### Slow activation

The extension uses a stub provider for instant model availability. If activation appears slow:

1. Run `Developer: Startup Performance` from the Command Palette.
2. Find **Vercel AI** — check `Load Code` vs `Finish Activate`.
3. A large `Finish Activate` means the async provider setup took time (network-dependent).

## License

MIT
