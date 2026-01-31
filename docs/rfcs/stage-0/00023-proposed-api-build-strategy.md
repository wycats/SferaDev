---
title: Proposed API Build Strategy
stage: 0
feature: Unknown
exo:
    tool: exo rfc create
    protocol: 1
---

# RFC 00023: Proposed API Build Strategy

**Status:** Draft  
**Author:** GitHub Copilot  
**Created:** 2026-01-30  
**Updated:** 2026-01-30

## Summary

Define a strategy for using VS Code's proposed APIs (like `LanguageModelThinkingPart`) with a two-build approach: stable builds for Marketplace, insiders builds with enhanced features.

## Motivation

VS Code's proposed APIs offer significant improvements:

- `LanguageModelThinkingPart` → Collapsible reasoning UI
- `languageModelCapabilities` → Runtime capability queries
- Future APIs as they become available

Currently we cannot use these in Marketplace-published extensions. We need a strategy to:

1. Ship stable builds without proposed APIs
2. Develop and test with proposed APIs
3. Smoothly transition when APIs stabilize

## Design

### Two-Build Strategy

| Build        | Target           | Proposals | Distribution         |
| ------------ | ---------------- | --------- | -------------------- |
| **Stable**   | VS Code Stable   | None      | Marketplace          |
| **Insiders** | VS Code Insiders | Enabled   | Manual / Pre-release |

### Package.json Configuration

**Stable build (default):**

```json
{
  "name": "vscode-ai-gateway",
  "version": "1.0.0"
}
```

**Insiders build:**

```json
{
  "name": "vscode-ai-gateway-insiders",
  "version": "1.0.0-insiders",
  "enabledApiProposals": ["chatProvider", "languageModelThinkingPart"]
}
```

### Runtime Feature Detection

Shared code uses runtime detection with type-safe fallbacks:

```typescript
// src/provider/proposed-apis.ts

import * as vscode from "vscode";

/**
 * Type-safe access to LanguageModelThinkingPart.
 * Returns undefined in stable VS Code.
 */
export const ThinkingPart = (vscode as any).LanguageModelThinkingPart as
  | (new (
      value: string | string[],
      id?: string,
    ) => vscode.LanguageModelTextPart)
  | undefined;

/**
 * Check if ThinkingPart is available at runtime.
 */
export function hasThinkingPartSupport(): boolean {
  return ThinkingPart !== undefined;
}

/**
 * Emit thinking content with automatic fallback.
 */
export function emitThinking(
  progress: vscode.Progress<vscode.LanguageModelTextPart>,
  content: string,
  id?: string,
): void {
  if (ThinkingPart) {
    progress.report(new ThinkingPart(content, id));
  } else {
    // Fallback: emit as plain text
    progress.report(new vscode.LanguageModelTextPart(content));
  }
}
```

### Build Configuration

**esbuild.config.js:**

```javascript
const isInsiders = process.env.BUILD_TYPE === "insiders";

module.exports = {
  // ... base config
  define: {
    "process.env.BUILD_TYPE": JSON.stringify(
      isInsiders ? "insiders" : "stable",
    ),
  },
};
```

**package.json scripts:**

```json
{
  "scripts": {
    "build": "BUILD_TYPE=stable node esbuild.config.js",
    "build:insiders": "BUILD_TYPE=insiders node esbuild.config.js",
    "package": "pnpm build && vsce package",
    "package:insiders": "pnpm build:insiders && vsce package --pre-release"
  }
}
```

### TypeScript Configuration

**tsconfig.json (stable):**

```json
{
  "compilerOptions": {
    "types": ["vscode"]
  }
}
```

**tsconfig.insiders.json:**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["vscode"],
    "typeRoots": ["./node_modules/@types", "./src/types"]
  },
  "include": ["src/**/*", "src/types/proposed.d.ts"]
}
```

**src/types/proposed.d.ts:**

```typescript
// Type declarations for proposed APIs
// Copy from VS Code's vscode-dts/vscode.proposed.*.d.ts

declare module "vscode" {
  export class LanguageModelThinkingPart {
    value: string | string[];
    id?: string;
    metadata?: { readonly [key: string]: any };
    constructor(
      value: string | string[],
      id?: string,
      metadata?: { readonly [key: string]: any },
    );
  }
}
```

## Usage in Stream Adapter

```typescript
// src/provider/stream-adapter.ts

import { emitThinking, hasThinkingPartSupport } from './proposed-apis';

private handleReasoningDelta(event: ResponseReasoningDeltaStreamingEvent): AdaptedEvent {
  const delta = event.delta ?? "";

  if (delta) {
    // Use proposed API when available, fallback to text otherwise
    if (hasThinkingPartSupport()) {
      return {
        parts: [new ThinkingPart(delta)],
        done: false,
      };
    } else {
      return {
        parts: [new LanguageModelTextPart(delta)],
        done: false,
      };
    }
  }

  return { parts: [], done: false };
}
```

## Testing Strategy

### Stable Build Testing

- Run against VS Code Stable
- Verify fallback behavior works
- Ensure no runtime errors from missing APIs

### Insiders Build Testing

- Run with: `code-insiders --enable-proposed-api vscode-ai-gateway-insiders`
- Verify ThinkingPart renders as collapsible blocks
- Test all proposed API features

### CI Configuration

```yaml
jobs:
  test-stable:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm build
      - run: pnpm test

  test-insiders:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm build:insiders
      - run: xvfb-run -a code-insiders --enable-proposed-api $EXT_ID --extensionTestsPath=./out/test
```

## Migration Path

When `LanguageModelThinkingPart` becomes stable:

1. **Detection phase:** API appears in stable VS Code
2. **Update types:** Remove proposed.d.ts, update @types/vscode
3. **Simplify code:** Remove feature detection, use API directly
4. **Merge builds:** Single build with native support

## Risks and Mitigations

| Risk                        | Mitigation                         |
| --------------------------- | ---------------------------------- |
| Proposed API changes        | Runtime detection prevents crashes |
| Type mismatches             | Loose typing with `as any` cast    |
| User confusion (two builds) | Clear naming, documentation        |
| Marketplace rejection       | Stable build has no proposals      |

## Alternatives Considered

### 1. Single Build with Feature Detection Only

- **Pro:** Simpler build process
- **Con:** Cannot test proposed APIs without manual setup
- **Rejected:** Want first-class insiders experience

### 2. Wait for Stable APIs

- **Pro:** No complexity
- **Con:** Users miss enhanced features for months/years
- **Rejected:** Want to deliver value sooner

### 3. Use enabledApiProposals in Stable

- **Pro:** One build
- **Con:** **Rejected by Marketplace** - extensions with proposals cannot be published
- **Rejected:** Not allowed

## Related RFCs

- [RFC 019: Proposed LM Provider APIs](./019-proposed-lm-provider-apis.md) - Documents the APIs this strategy enables

## References

- [VS Code Proposed API Documentation](https://code.visualstudio.com/api/advanced-topics/using-proposed-api)
- [GCMP extension pattern](https://github.com/nicepkg/gpt-runner) - Uses pre-release builds with proposals
