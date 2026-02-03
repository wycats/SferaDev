# Vercel AI Gateway for VS Code

**Use any AI model in VS Code's native chat—powered by Vercel.**

This extension brings [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) models directly into VS Code's built-in chat interface. Access GPT-4o, Claude, Gemini, and 100+ other models through a single authentication, with unified billing through Vercel.

<p align="center">
  <img src="packages/vscode-ai-gateway/images/icon.png" alt="Vercel AI Gateway" width="128" />
</p>

## Why This Extension?

VS Code's Language Model API lets extensions provide AI models to the native chat interface—the same interface GitHub Copilot uses. This extension implements that API for Vercel AI Gateway, which means:

- **One auth, all models** — GPT-4o, Claude Sonnet, Gemini Pro, Mistral, and more through a single Vercel API key
- **Native experience** — Models appear in VS Code's model picker alongside Copilot; no custom UI panels
- **Unified billing** — All AI usage flows through Vercel's metering, regardless of underlying provider
- **Enterprise ready** — OIDC authentication ties access to Vercel team/project permissions

```
┌─────────────────────────────────────────────────────────┐
│                    VS Code Chat                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Model: [Vercel AI: claude-sonnet-4 ▼]            │  │
│  └───────────────────────────────────────────────────┘  │
│                          │                              │
│                          ▼                              │
│  ┌───────────────────────────────────────────────────┐  │
│  │         Vercel AI Gateway Extension               │  │
│  │  • Streaming responses with tool calling          │  │
│  │  • Accurate token counting for context management │  │
│  │  • Image input for vision-capable models          │  │
│  └───────────────────────────────────────────────────┘  │
│                          │                              │
│                          ▼                              │
│  ┌───────────────────────────────────────────────────┐  │
│  │            Vercel AI Gateway                      │  │
│  │  OpenAI • Anthropic • Google • Mistral • ...      │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## Quick Start

### Install from Marketplace

1. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=vercel.vscode-ai-gateway)
2. Open Command Palette (`Cmd/Ctrl + Shift + P`)
3. Run **"Vercel AI: Manage Authentication"**
4. Enter your Vercel AI Gateway API key (starts with `vck_`)

### Build from Source

```bash
# Clone and install
git clone https://github.com/vercel-labs/vscode-ai-gateway
cd vscode-ai-gateway
pnpm install

# Build and install the extension
cd packages/vscode-ai-gateway
pnpm build
pnpm package
code --install-extension *.vsix
```

## Features

### Multi-Provider Model Access

Access models from all major AI providers through Vercel's unified API:

| Provider  | Example Models                          |
| --------- | --------------------------------------- |
| OpenAI    | gpt-4o, gpt-4-turbo, o1, o3-mini        |
| Anthropic | claude-sonnet-4, claude-opus-4          |
| Google    | gemini-2.0-flash, gemini-1.5-pro        |
| Mistral   | mistral-large, codestral               |
| And more  | Llama, Cohere, AI21, Perplexity...      |

### Intelligent Token Management

The extension provides accurate token counting to help VS Code manage context effectively:

- **Tiktoken estimation** for OpenAI-compatible tokenizers
- **Adaptive correction** that learns from API responses
- **Per-message caching** so edited messages don't invalidate the whole context

### Tool Calling Support

Full support for VS Code's tool system—file operations, terminal commands, and custom tools all work seamlessly through the extension.

### Enterprise Authentication

Two authentication modes for different use cases:

- **API Key** — Simple setup for individual developers
- **OIDC** — Leverages Vercel CLI login for team/project-scoped access with automatic token refresh

## Configuration

Settings are available under `vercel.ai.*` in VS Code:

| Setting                        | Description                              | Default                        |
| ------------------------------ | ---------------------------------------- | ------------------------------ |
| `vercel.ai.endpoint`           | AI Gateway URL (for self-hosted)         | `https://ai-gateway.vercel.sh` |
| `vercel.ai.models.allowlist`   | Restrict to specific models (glob)       | `[]` (all models)              |
| `vercel.ai.models.denylist`    | Hide specific models (glob)              | `[]`                           |
| `vercel.ai.models.default`     | Pre-select a default model               | `""`                           |
| `vercel.ai.logging.level`      | Debug verbosity                          | `"warn"`                       |

### Enterprise Example

```json
{
  "vercel.ai.endpoint": "https://ai-gateway.acme-corp.vercel.app",
  "vercel.ai.models.allowlist": ["anthropic:claude-*", "openai:gpt-4o"],
  "vercel.ai.models.denylist": ["*:gpt-3.5-*"]
}
```

## Repository Structure

```
├── packages/
│   ├── vscode-ai-gateway/        # The VS Code extension
│   └── openresponses-client/     # TypeScript client for OpenResponses API
├── configs/
│   └── tsconfig/                 # Shared TypeScript configuration
└── docs/
    ├── design/                   # Vision and design documents
    ├── rfcs/                     # Request for Comments
    ├── research/                 # API research and type definitions
    └── specs/                    # Technical specifications
```

## Development

```bash
# Run tests
pnpm test

# Build in watch mode
cd packages/vscode-ai-gateway
pnpm build --watch

# Run linter
pnpm lint
```

## Documentation

- [Vision Document](docs/design/VISION-vscode-ai-gateway.md) — Strategic overview and architecture
- [Extension README](packages/vscode-ai-gateway/README.md) — Extension-specific details
- [OpenResponses Client](packages/openresponses-client/README.md) — API client documentation
- [RFCs](docs/rfcs/) — Design decisions and proposals

## Contributing

This project is maintained by Vercel. For internal contributors, see the [AGENTS.md](AGENTS.md) file for AI-assisted development guidelines.

## License

MIT
