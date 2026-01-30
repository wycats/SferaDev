# Vercel AI Gateway for VS Code

A VS Code extension that provides access to AI models through the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) via VS Code's Language Model API.

## Overview

This extension enables VS Code users to access a wide range of AI models (GPT-4, Claude, Gemini, and more) through Vercel's unified AI Gateway. It integrates with VS Code's native Language Model API, making these models available to GitHub Copilot Chat and other extensions that use the API.

## Repository Structure

```
├── apps/vscode-ai-gateway/     # The VS Code extension
├── packages/openresponses-client/  # TypeScript client for OpenResponses API
├── configs/tsconfig/           # Shared TypeScript configuration
└── docs/                       # Documentation, RFCs, and research
    ├── rfcs/                   # Request for Comments documents
    ├── research/               # API research and type definitions
    └── design/                 # Design documents and vision
```

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm 9+
- VS Code 1.108+

### Installation

```bash
# Install dependencies
pnpm install

# Build the extension
cd apps/vscode-ai-gateway
pnpm build

# Package and install
pnpm package
code --install-extension *.vsix
```

### Development

```bash
# Run tests
pnpm test

# Build in watch mode (from apps/vscode-ai-gateway)
pnpm build --watch
```

## Documentation

- [Extension README](apps/vscode-ai-gateway/README.md) - Extension-specific documentation
- [OpenResponses API](docs/OPENRESPONSES.md) - API integration details
- [RFCs](docs/rfcs/) - Design decisions and proposals
- [Research](docs/research/) - API research and type definitions

## License

MIT
