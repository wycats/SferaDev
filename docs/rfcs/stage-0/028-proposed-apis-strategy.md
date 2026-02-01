---
title: Proposed APIs Strategy
stage: 0
feature: proposed-apis
exo:
  tool: exo rfc create
  protocol: 1
---

# RFC 028: Proposed APIs Strategy

**Status:** Stage 0 (Draft)  
**Created:** 2026-01-31  
**Related:** RFC 00021 (VS Code Proposed Language Model Provider APIs), RFC 00023 (Proposed API Build Strategy)

## Summary

Define a strategy for tracking and adopting VS Code proposed APIs relevant to the AI Gateway extension, including:

- Inventory of key proposed APIs
- Two-build strategy (stable Marketplace build, Insiders build with proposals)
- Runtime feature detection patterns
- Migration paths as APIs stabilize

## Motivation

Proposed APIs unlock important capabilities (thinking parts, system messages, runtime capability exposure) but cannot be used in Marketplace extensions. We need a strategy that:

1. Preserves Marketplace compatibility
2. Allows Insiders-only experimentation
3. Enables smooth transitions when APIs stabilize

## Proposed APIs Inventory

### Core Provider API: `chatProvider`

- **File:** `vscode.proposed.chatProvider.d.ts`
- **Relevance:** Core to provider registration
- **Notes:** Some properties are explicitly marked as not finalized

### Thinking/Reasoning: `languageModelThinkingPart`

- **File:** `vscode.proposed.languageModelThinkingPart.d.ts`
- **Relevance:** Enables collapsible reasoning UI
- **Current workaround:** emit as `LanguageModelTextPart`

### Capability Exposure: `languageModelCapabilities`

- **File:** `vscode.proposed.languageModelCapabilities.d.ts`
- **Relevance:** Consumer-side capability query interface
- **Current workaround:** capability tags from `/models`

### System Messages: `languageModelSystem`

- **File:** `vscode.proposed.languageModelSystem.d.ts`
- **Relevance:** native system role support
- **Current workaround:** map to OpenResponses `developer` role

### Content Audience: `languageModelToolResultAudience`

- **File:** `vscode.proposed.languageModelToolResultAudience.d.ts`
- **Relevance:** route parts to model/user/extension
- **Current workaround:** all content visible to both

### Tool Progress: `toolProgress`

- **File:** `vscode.proposed.toolProgress.d.ts`
- **Relevance:** tool provider progress reporting
- **Impact:** mostly informational for LM providers

## Strategy

### Two-Build Approach

| Build        | Target           | Proposals | Distribution         |
| ------------ | ---------------- | --------- | -------------------- |
| **Stable**   | VS Code Stable   | None      | Marketplace          |
| **Insiders** | VS Code Insiders | Enabled   | Manual / Pre-release |

### Runtime Feature Detection

Use runtime guards and fallbacks:

```typescript
export const ThinkingPart = (vscode as any).LanguageModelThinkingPart as
  | (new (
      value: string | string[],
      id?: string,
    ) => vscode.LanguageModelTextPart)
  | undefined;

export function hasThinkingPartSupport(): boolean {
  return ThinkingPart !== undefined;
}
```

### Emission Helper (Fallback)

```typescript
export function emitThinking(
  progress: vscode.Progress<vscode.LanguageModelTextPart>,
  content: string,
  id?: string,
): void {
  if (ThinkingPart) {
    progress.report(new ThinkingPart(content, id));
  } else {
    progress.report(new vscode.LanguageModelTextPart(content));
  }
}
```

## Build Configuration

### Stable Build (Marketplace)

- No `enabledApiProposals`
- Use stable `@types/vscode`

### Insiders Build

- `enabledApiProposals` includes needed APIs
- Additional `proposed.d.ts` for typing
- Pre-release packaging

## Migration Paths

For each API:

1. **Detect availability** in stable VS Code.
2. **Update typings** to stable `@types/vscode`.
3. **Remove proposed declarations** and runtime guards.
4. **Merge builds** if all critical APIs stabilize.

## Testing Strategy

### Stable Build

- Run on VS Code Stable
- Verify fallbacks (no runtime errors)

### Insiders Build

- Run on VS Code Insiders with `--enable-proposed-api`
- Validate enhanced UX (thinking parts, capability exposure)

## Risks & Mitigations

| Risk                  | Mitigation                         |
| --------------------- | ---------------------------------- |
| Proposed API changes  | Runtime detection & fallback       |
| Marketplace rejection | Stable build contains no proposals |
| Type mismatch         | Loose typing with `as any`         |
| User confusion        | Clear build naming & docs          |

## References

- RFC 00021: VS Code Proposed Language Model Provider APIs
- RFC 00023: Proposed API Build Strategy
- [VS Code proposed API docs](https://code.visualstudio.com/api/advanced-topics/using-proposed-api)
- `docs/research/message-translation-mapping.md`
