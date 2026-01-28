# RFC 001: Standalone Repository Structure

**Status:** Draft  
**Author:** Vercel AI Team  
**Created:** 2026-01-27  
**Updated:** 2026-01-27

## Summary

Extract the VS Code AI Gateway extension from the SferaDev monorepo into a standalone repository at `vercel/vscode-ai-gateway`, establishing proper CI/CD workflows for VS Code Marketplace publishing and providing a clear migration path for existing users. Migration and deprecation details are defined in RFC 007.

## Motivation

The current extension lives in `apps/vscode-ai-gateway/` within the SferaDev monorepo. While this structure works for development, an official Vercel extension requires:

1. **Clear ownership**: A dedicated repository under the `vercel` organization signals official support
2. **Simplified contributions**: External contributors can focus on extension-specific code
3. **Independent release cycles**: Extension releases shouldn't be tied to unrelated package updates
4. **Marketplace requirements**: VS Code Marketplace publishing workflows are simpler with dedicated repos
5. **Documentation focus**: README, CONTRIBUTING, and docs can be extension-specific

## Detailed Design

### Repository Structure

```
vercel/vscode-ai-gateway/
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                 # Build, lint, test on PR
│   │   ├── release.yml            # Semantic versioning + changelog
│   │   └── marketplace.yml        # VS Code Marketplace publish
│   ├── CODEOWNERS
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.md
│   │   └── feature_request.md
│   └── pull_request_template.md
├── src/
│   ├── extension.ts               # Entry point, activation
│   ├── provider.ts                # LanguageModelChatProvider
│   ├── auth/
│   │   ├── index.ts               # Auth exports
│   │   ├── api-key.ts             # API key authentication
│   │   └── oidc.ts                # OIDC token authentication
│   ├── models/
│   │   ├── client.ts              # Model discovery client
│   │   └── types.ts               # Model type definitions
│   ├── streaming/
│   │   ├── chunk-handler.ts       # Stream chunk mapping
│   │   ├── token-estimator.ts     # Hybrid token estimation
│   │   └── types.ts               # Streaming types
│   └── utils/
│       ├── logger.ts              # Structured logging
│       └── mime.ts                # MIME type validation
├── test/
│   ├── provider.test.ts           # Provider unit tests
│   ├── streaming.test.ts          # Stream handling tests
│   ├── auth.test.ts               # Authentication tests
│   └── fixtures/                  # Test fixtures
├── images/
│   ├── icon.png                   # Extension icon (128x128)
│   └── icon-dark.png              # Dark theme variant
├── .vscodeignore                  # Files to exclude from VSIX
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── biome.json                     # Linting/formatting
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE                        # MIT
└── README.md
```

### CI/CD Workflows

#### `ci.yml` - Continuous Integration

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: "pnpm"
      - run: pnpm install --frozen-lockfile
      - run: pnpm run lint
      - run: pnpm run tsc
      - run: pnpm run test
      - run: pnpm run build

  package:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
      - uses: actions/setup-node@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm run package
      - uses: actions/upload-artifact@v4
        with:
          name: vsix
          path: "*.vsix"
```

#### `release.yml` - Semantic Release

```yaml
name: Release

on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v4
        id: release
        with:
          release-type: node
      - if: ${{ steps.release.outputs.release_created }}
        uses: actions/checkout@v4
      - if: ${{ steps.release.outputs.release_created }}
        run: |
          pnpm install --frozen-lockfile
          pnpm run package
      - if: ${{ steps.release.outputs.release_created }}
        uses: actions/upload-release-asset@v1
        with:
          upload_url: ${{ steps.release.outputs.upload_url }}
          asset_path: ./vercel-ai-gateway-${{ steps.release.outputs.major }}.${{ steps.release.outputs.minor }}.${{ steps.release.outputs.patch }}.vsix
          asset_name: vercel-ai-gateway.vsix
          asset_content_type: application/octet-stream
```

#### `marketplace.yml` - VS Code Marketplace Publishing

```yaml
name: Publish to Marketplace

on:
  release:
    types: [published]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
      - uses: actions/setup-node@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm run package
      - name: Publish to VS Code Marketplace
        run: pnpm exec vsce publish --no-dependencies -p ${{ secrets.VSCE_PAT }}
      - name: Publish to Open VSX
        run: pnpm exec ovsx publish --no-dependencies -p ${{ secrets.OVSX_PAT }}
```

### Package.json Changes

```json
{
  "name": "vscode-ai-gateway",
  "publisher": "vercel",
  "displayName": "Vercel AI",
  "description": "Access AI models through Vercel AI Gateway in VS Code",
  "version": "1.0.0",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/vercel/vscode-ai-gateway"
  },
  "homepage": "https://vercel.com/docs/ai-gateway",
  "bugs": {
    "url": "https://github.com/vercel/vscode-ai-gateway/issues"
  }
}
```

### Migration and Deprecation

Migration and deprecation details are consolidated in **RFC 007: Migration & Deprecation**, including the settings migration script, namespace transitions, and user communication plan.

## Drawbacks

1. **Maintenance overhead**: Separate repository means separate issue tracking, PR reviews
2. **Dependency sync**: Need to manually update `@ai-sdk/gateway` and `ai` versions
3. **Code duplication**: Some utilities might be duplicated from the monorepo
4. **Build tooling**: Need to set up build tooling from scratch (though can copy from monorepo)

## Alternatives

### Alternative 1: Keep in Monorepo, Change Publisher

Keep the code in SferaDev monorepo but publish under `vercel` publisher. This maintains code organization but creates confusion about ownership.

**Rejected because:** Confusing governance model, harder for external contributors.

### Alternative 2: Git Subtree/Submodule

Use git subtree to maintain code in both repositories.

**Rejected because:** Adds complexity, sync issues, confusing for contributors.

### Alternative 3: NPM Package + Thin Extension

Extract core logic to `@vercel/ai-gateway-core` NPM package, keep thin extension wrapper.

**Considered for RFC 003:** This is complementary, not alternative. The extension still needs its own repo.

## Unresolved Questions

1. **Repository naming**: `vscode-ai-gateway` vs `vscode-ai` vs `ai-gateway-vscode`?
2. **Monorepo deprecation**: Should the SferaDev version be archived or maintained in parallel?
3. **Issue migration**: Should existing GitHub issues be transferred?
4. **Contributor recognition**: How to acknowledge SferaDev contributions in the new repo?

## Implementation Plan

### Phase 1: Repository Setup (Week 1)

- [ ] Create `vercel/vscode-ai-gateway` repository
- [ ] Set up GitHub Actions workflows
- [ ] Configure branch protection rules
- [ ] Set up CODEOWNERS

### Phase 2: Code Migration (Week 1-2)

- [ ] Copy source files with git history preservation
- [ ] Update package.json metadata
- [ ] Update import paths
- [ ] Verify build and tests pass

### Phase 3: Documentation (Week 2)

- [ ] Write comprehensive README
- [ ] Create CONTRIBUTING.md
- [ ] Document migration from SferaDev extension
- [ ] Set up GitHub Pages for docs (optional)

### Phase 4: Release (Week 3)

- [ ] Publish v1.0.0 to VS Code Marketplace
- [ ] Publish to Open VSX Registry
- [ ] Announce on Vercel blog/social
- [ ] Update SferaDev extension with deprecation notice
