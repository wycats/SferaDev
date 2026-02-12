# Vercel AI Gateway - VS Code Extension

A VS Code extension that provides [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) models via the Language Model API, integrating AI models directly within VS Code's native chat interface.

## Features

- **Multiple AI Models** - Access GPT-4o, Claude, Gemini, and all Vercel AI Gateway models
- **Native Integration** - Works with VS Code's built-in chat interface and Copilot
- **Streaming Responses** - Real-time streaming of AI responses
- **Tool Calling** - Full support for VS Code tool integration
- **OpenResponses API** - Uses the [OpenResponses](https://www.openresponses.org) wire protocol for accurate token usage

## Quick Start

1. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=vercel.vscode-ai-gateway)
2. Open Command Palette (`Cmd/Ctrl + Shift + P`)
3. Run "Vercel AI Gateway: Manage Authentication"
4. Enter your API key (starts with `vck_`)

## Diagnostics (Activation Timing)

If the Extensions view shows a large activation time, use VS Code's built-in tools to see where the time is spent:

1. Open Command Palette (`Cmd/Ctrl + Shift + P`).
2. Run `Developer: Startup Performance`.
3. Find **Vercel AI** and note `Load Code`, `Call Activate`, and `Finish Activate`.

`Load Code + Call Activate` is the number shown in the Extensions view. A large `Finish Activate` means `activate()` returned a promise that took time to resolve.

You can also run `Developer: Show Running Extensions` and sort by activation time for a live view.

## Architecture

This extension uses two API modes:

1. **Vercel AI SDK** - For standard chat completions (legacy)
2. **OpenResponses API** - For streaming with accurate token usage reporting

### OpenResponses Integration

The OpenResponses integration (`src/provider/openresponses-chat.ts`) communicates directly with the OpenResponses wire protocol.

**Important**: The OpenResponses API is:

- **NOT** the OpenAI Chat Completions API
- **NOT** the Vercel AI SDK format
- A distinct wire protocol based on (but independent from) the OpenAI Responses API

See the [openresponses-client documentation](../../packages/openresponses-client/README.md) for details.

## Documentation

- **Extension Docs**: [https://github.com/vercel-labs/vscode-ai-gateway](https://github.com/vercel-labs/vscode-ai-gateway)
- **OpenResponses Spec**: [../../packages/openresponses-client/docs/OPENRESPONSES-SPEC.md](../../packages/openresponses-client/docs/OPENRESPONSES-SPEC.md)
- **OpenAPI Schema**: [../../packages/openresponses-client/openapi.json](../../packages/openresponses-client/openapi.json)

## License

MIT
