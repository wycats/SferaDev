# CONTRIBUTING (DRAFT)

Thanks for contributing to the Vercel AI Gateway VS Code Extension. This is a working draft to help new contributors get productive quickly.

## Prerequisites

- Node.js $\ge$ 22
- pnpm 10.26.2 (from the repo’s packageManager field)
- VS Code $\ge$ 1.108.0

## Getting Started

```bash
pnpm install
pnpm build
```

To run the extension in development:

1. Open the repo in VS Code.
2. Press F5 to launch an Extension Development Host.

## Project Structure

This repo is a monorepo:

- packages/vscode-ai-gateway: VS Code extension source and build/test tooling
- packages/openresponses-client: Internal OpenResponses client and generated types

Key directories in packages/vscode-ai-gateway/src/:

- provider/ — Core LM provider logic (openresponses-chat.ts, stream-adapter.ts, message-translation.ts)
- tokens/ — Token estimation
- models/ — Model discovery and configuration
- identity/ — Agent identity tracking (claim-registry.ts)
- logger/ — Logging infrastructure
- persistence/ — Data persistence
- diagnostics/ — Diagnostic tools
- utils/ — Shared utilities
- Root files: auth.ts, vercel-auth.ts, agent-tree.ts, status-bar.ts

## Development Workflow

Build (root):

```bash
pnpm build
```

Watch mode (extension package):

```bash
cd packages/vscode-ai-gateway
pnpm dev
```

Tests:

```bash
pnpm test
cd packages/vscode-ai-gateway && pnpm test:watch
```

Linting:

```bash
pnpm lint
pnpm lint:fix
```

Packaging:

```bash
cd packages/vscode-ai-gateway
pnpm package
```

Local installation (from the extension package directory):

```bash
cd packages/vscode-ai-gateway
code --install-extension *.vsix
```

## Architecture Overview

- Integrates with the VS Code Language Model API to provide models via Vercel AI Gateway.
- Uses the OpenResponses wire protocol (not OpenAI Chat Completions).
- Core integration points:

| Area                   | Key Files                           | Purpose                                   |
| ---------------------- | ----------------------------------- | ----------------------------------------- |
| OpenResponses provider | src/provider/openresponses-chat.ts  | API request/response handling             |
| Stream adapter         | src/provider/stream-adapter.ts      | Convert streaming events to VS Code parts |
| Message translation    | src/provider/message-translation.ts | Role/content mapping and tool translation |
| Token usage            | src/provider/usage-tracker.ts       | Token tracking                            |
| Token estimation       | src/tokens/                         | Estimation logic                          |
| Model discovery        | src/models/                         | Model listing and metadata                |
| Agent identity         | src/identity/claim-registry.ts      | Agent identity tracking                   |
| Status UI              | src/status-bar.ts                   | Status bar and agent token UI             |
| Auth                   | src/auth.ts, src/vercel-auth.ts     | Auth flow and Vercel login                |

## ⚠️ Critical Warnings

These are required invariants (from AGENTS.md):

- OpenResponses is **not** the OpenAI Chat Completions API (and not the Vercel AI SDK).
- Content type rules: User messages use `input_text`, Assistant messages use `output_text`.
- Tools use a **flat** structure (not nested under `function`).
- **DO NOT remove** `extractSystemPrompt()` from openresponses-chat.ts.

These invariants are enforced by tests in `message-translation.test.ts`, `request-builder.test.ts`, and `system-prompt.test.ts`.

## Testing

- Unit tests use Vitest.
- Test files are colocated alongside sources (e.g., \*.test.ts).
- Integration tests are available in the extension package:

```bash
cd packages/vscode-ai-gateway
pnpm test:integration
```

## Debugging

- Logging levels: configure `vercel.ai.logging.level` (off, error, warn, info, debug, trace).
- Agent tree diagnostics:

```bash
cd packages/vscode-ai-gateway
pnpm analyze:logs -- --narrative
```

- Forensic capture: enable `vercel.ai.debug.forensicCapture` (and optionally `vercel.ai.debug.forensicCaptureFullContent`).

## OpenResponses Client

- Internal package only (private, not published).
- Generated types from OpenAPI via Kubb.
- Regenerate client:

```bash
cd packages/openresponses-client
pnpm generate
```

- Zod schemas are exported for runtime validation.

## Documentation

- RFCs live in docs/rfcs/ (stages 0–4).
- Design docs: docs/design/.
- Specs: docs/specs/.
- Each package may include an AGENTS.md for AI assistants.

## Code Style

- ESLint with TypeScript strict configuration.
- Use underscore-prefixed names for unused variables (e.g., `_unused`).

## Pull Request Process

- Ensure all CI checks pass (build, tests, lint).
- Significant changes should follow the RFC process in docs/rfcs/.
