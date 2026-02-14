# vscode-extension-vercel-ai

## 0.3.0

### Minor Changes — Internal Release

#### Authentication & Onboarding

- Secure credential storage via VS Code's `SecretStorage` API
- Two auth methods: manual API key entry and Vercel OIDC (auto-detected when CLI is logged in)
- Session management: add, switch, and remove authentication sessions
- First-run welcome notification guides new users to authenticate
- Storage key migration from legacy `vercelAiGateway.*` namespace

#### Error UX & Resilience

- Structured error surfaces with user-friendly messages for all failure modes
- Automatic retry with exponential backoff for transient network/server errors
- Error log capture and export command for debugging
- Graceful handling of auth expiry, rate limits, and malformed responses

#### Model Discovery & Selection

- Configurable default model (`vercel.ai.models.default`) with priority chain: config → last-selected → first available
- `userSelectable` setting to make all models immediately visible in the picker
- Refresh Models command to force-fetch the latest model list
- Stale-while-revalidate model cache with ETag conditional requests

#### Performance & Architecture

- Stub provider for instant model availability on startup (no async wait)
- Cached models served synchronously from `globalState` on reload
- Code-split bundle via esbuild for lazy-loaded heavy modules
- OpenResponses wire protocol for streaming with accurate token usage

#### Token Tracking & Diagnostics

- Status bar token counter (input/output per conversation)
- Agent Tree sidebar with per-conversation token usage breakdown
- Investigation logging with configurable detail levels (`off`/`index`/`messages`/`full`)
- Tree diagnostics and summarization detection tooling

#### Packaging

- Cleaned `.vscodeignore` to exclude dev artifacts from VSIX
- Reduced VSIX file count (135 → 128 files)

## 0.2.2

### Patch Changes

- c513d19: Fix auth session bugs in VSCode extension

## 0.2.1

### Patch Changes

- da0f1aa: Update docs

## 0.2.0

### Minor Changes

- Migrated to SferaDev monorepo
- Updated repository URLs and package configuration
- Added VSCE release workflow with GitHub CI integration
