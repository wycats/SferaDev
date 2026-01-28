# RFC 002: Branding and Identity

**Status:** Draft  
**Author:** Vercel AI Team  
**Created:** 2026-01-27  
**Updated:** 2026-01-27

## Summary

Rebrand the VS Code AI Gateway extension from SferaDev to official Vercel identity, including publisher change, vendor namespace update, and visual identity refresh. Migration and deprecation mechanics are covered in RFC 007.

## Motivation

The current extension uses SferaDev branding:

- **Publisher:** `SferaDev`
- **Vendor:** `vercelAiGateway`
- **Extension ID:** `SferaDev.vscode-extension-vercel-ai`
- **Auth Provider:** `vercelAiAuth`

For an official Vercel extension, users expect:

- Official `vercel` publisher badge in Marketplace
- Consistent naming with other Vercel products
- Trust signals (verified publisher, official support)
- Integration with Vercel's documentation and support channels

## Detailed Design

### Identity Changes

| Attribute        | Current                               | Proposed                   |
| ---------------- | ------------------------------------- | -------------------------- |
| Publisher        | `SferaDev`                            | `vercel`                   |
| Extension ID     | `SferaDev.vscode-extension-vercel-ai` | `vercel.vscode-ai-gateway` |
| Display Name     | `Vercel AI Gateway`                   | `Vercel AI`                |
| Vendor           | `vercelAiGateway`                     | `vercel`                   |
| Auth Provider ID | `vercelAiAuth`                        | `vercel.ai.auth`           |
| Config Namespace | `vercelAiGateway.*`                   | `vercel.ai.*`              |
| Command Prefix   | `vercelAiGateway.*`                   | `vercel.ai.*`              |

### Migration & Deprecation

Migration mechanics, namespace transitions, and deprecation timelines are defined in **RFC 007: Migration & Deprecation**.

### Package.json Updates

```json
{
  "name": "vscode-ai-gateway",
  "publisher": "vercel",
  "displayName": "Vercel AI",
  "description": "Access 100+ AI models through Vercel AI Gateway directly in VS Code",
  "version": "1.0.0",
  "icon": "images/vercel-icon.png",
  "galleryBanner": {
    "color": "#000000",
    "theme": "dark"
  },
  "categories": ["AI", "Chat", "Machine Learning"],
  "keywords": [
    "ai",
    "vercel",
    "copilot",
    "chat",
    "gpt",
    "claude",
    "gemini",
    "llm",
    "language model",
    "ai gateway"
  ],
  "contributes": {
    "languageModelChatProviders": [
      {
        "vendor": "vercel",
        "displayName": "Vercel AI"
      }
    ],
    "commands": [
      {
        "command": "vercel.ai.authenticate",
        "title": "Sign In",
        "category": "Vercel AI"
      },
      {
        "command": "vercel.ai.signOut",
        "title": "Sign Out",
        "category": "Vercel AI"
      },
      {
        "command": "vercel.ai.selectModel",
        "title": "Select Default Model",
        "category": "Vercel AI"
      },
      {
        "command": "vercel.ai.showModels",
        "title": "Show Available Models",
        "category": "Vercel AI"
      }
    ],
    "configuration": {
      "title": "Vercel AI",
      "properties": {
        "vercel.ai.systemPrompt.enabled": {
          "type": "boolean",
          "default": false,
          "description": "Inject a system prompt identifying the Vercel AI Gateway to the model."
        },
        "vercel.ai.systemPrompt.message": {
          "type": "string",
          "default": "You are being accessed through Vercel AI Gateway in VS Code.",
          "description": "The system prompt message to inject when enabled."
        },
        "vercel.ai.defaultModel": {
          "type": "string",
          "default": "",
          "description": "Default model to use (e.g., 'anthropic/claude-sonnet-4-20250514')"
        },
        "vercel.ai.reasoning.showThinking": {
          "type": "boolean",
          "default": true,
          "description": "Display model reasoning/thinking when available."
        }
      }
    },
    "authentication": [
      {
        "id": "vercel.ai.auth",
        "label": "Vercel AI Gateway"
      }
    ]
  }
}
```

### Visual Identity

#### Extension Icon

The icon should follow Vercel's design system:

- **Primary:** Vercel triangle logo
- **Size:** 128x128px (with 256x256 for retina)
- **Background:** Transparent or Vercel black (#000000)
- **Format:** PNG

```
images/
├── vercel-icon.png          # 128x128 main icon
├── vercel-icon@2x.png       # 256x256 retina
├── vercel-icon-light.png    # For light themes
└── vercel-icon-dark.png     # For dark themes
```

#### Gallery Banner

For VS Code Marketplace listing:

```json
{
  "galleryBanner": {
    "color": "#000000",
    "theme": "dark"
  }
}
```

### Authentication Provider Update

```typescript
// src/auth/index.ts

// Old
export const VERCEL_AI_AUTH_PROVIDER_ID = "vercelAiAuth";

// New
export const VERCEL_AI_AUTH_PROVIDER_ID = "vercel.ai.auth";
export const VERCEL_AI_AUTH_PROVIDER_LABEL = "Vercel AI Gateway";

// Authentication provider registration
export class VercelAIAuthenticationProvider
  implements vscode.AuthenticationProvider
{
  static readonly id = VERCEL_AI_AUTH_PROVIDER_ID;
  static readonly label = VERCEL_AI_AUTH_PROVIDER_LABEL;

  // ... implementation
}
```

### Model Display Names

Models should display with clear provider attribution:

```typescript
// src/models/client.ts

interface ModelDisplayInfo {
  id: string; // e.g., "anthropic/claude-sonnet-4-20250514"
  displayName: string; // e.g., "Claude Sonnet 4 (Anthropic)"
  family: string; // e.g., "claude"
  vendor: string; // Always "vercel"
}

function formatModelDisplayName(modelId: string): string {
  const [provider, model] = modelId.split("/");
  const providerName = PROVIDER_DISPLAY_NAMES[provider] || provider;
  const modelName = formatModelName(model);
  return `${modelName} (${providerName})`;
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  mistral: "Mistral",
  meta: "Meta",
  cohere: "Cohere",
};
```

### README Branding

```markdown
# Vercel AI for VS Code

<p align="center">
  <img src="images/vercel-icon.png" width="128" height="128" alt="Vercel AI">
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=vercel.vscode-ai-gateway">
    <img src="https://img.shields.io/visual-studio-marketplace/v/vercel.vscode-ai-gateway" alt="VS Marketplace Version">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=vercel.vscode-ai-gateway">
    <img src="https://img.shields.io/visual-studio-marketplace/d/vercel.vscode-ai-gateway" alt="VS Marketplace Downloads">
  </a>
  <a href="https://github.com/vercel/vscode-ai-gateway/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/vercel/vscode-ai-gateway" alt="License">
  </a>
</p>

Access 100+ AI models from OpenAI, Anthropic, Google, Mistral, and more through
[Vercel AI Gateway](https://vercel.com/docs/ai-gateway) directly in VS Code.

## Features

- 🤖 **Multi-Provider Access** — Use GPT-4, Claude, Gemini, and more with a single API key
- 🔧 **Full Tool Support** — Native VS Code tool calling integration
- 📊 **Smart Token Management** — Accurate context tracking and estimation
- 🔐 **Secure Authentication** — API keys stored in VS Code's secure storage
- ⚡ **Streaming Responses** — Real-time token streaming with reasoning display

## Quick Start

1. Install from [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=vercel.vscode-ai-gateway)
2. Run **Vercel AI: Sign In** from the Command Palette
3. Enter your [AI Gateway API key](https://vercel.com/docs/ai-gateway/authentication-and-byok)
4. Open GitHub Copilot Chat and select a Vercel AI model

## Documentation

- [Getting Started](https://vercel.com/docs/ai-gateway/vscode)
- [Model Selection](https://vercel.com/docs/ai-gateway/models)
- [Tool Calling](https://vercel.com/docs/ai-gateway/tools)
- [Troubleshooting](https://vercel.com/docs/ai-gateway/vscode/troubleshooting)

## Support

- [GitHub Issues](https://github.com/vercel/vscode-ai-gateway/issues)
- [Vercel Community](https://community.vercel.com/)
- [Documentation](https://vercel.com/docs/ai-gateway)
```

## Drawbacks

1. **Migration and deprecation risk**: Requires user messaging and a structured transition (see RFC 007)
2. **Branding churn**: Marketplace listing and external references must be updated

## Alternatives

### Alternative 1: Keep `vercelAiGateway` Vendor

Maintain backward compatibility by keeping the vendor name.

**Rejected because:** Inconsistent with Vercel branding, longer than necessary.

### Alternative 2: Use `vercel-ai` as Vendor

Use hyphenated form for vendor name.

**Rejected because:** VS Code vendor names typically don't use hyphens; `vercel` is cleaner.

## Unresolved Questions

1. **Verified publisher badge**: What's the process for getting Vercel verified on VS Code Marketplace?
2. **Icon licensing**: Can we use the official Vercel logo, or do we need a variant?
3. **Documentation hosting**: Vercel docs site vs. GitHub Pages vs. in-extension?

## Implementation Plan

### Phase 1: Asset Preparation (Week 1)

- [ ] Design extension icon following Vercel brand guidelines
- [ ] Create gallery banner assets
- [ ] Write new README content
- [ ] Prepare Marketplace listing description

### Phase 2: Code Updates (Week 1-2)

- [ ] Update all namespace references
- [ ] Implement settings migration logic
- [ ] Update authentication provider ID
- [ ] Update command IDs and labels

### Phase 3: Publisher Setup (Week 2)

- [ ] Create/verify `vercel` publisher on VS Code Marketplace
- [ ] Set up publishing credentials in GitHub secrets
- [ ] Test publishing to Marketplace (pre-release)
