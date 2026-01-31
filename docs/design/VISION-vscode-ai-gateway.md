# Vercel AI Gateway VS Code Extension: Vision Document

**Version:** 1.0  
**Date:** January 28, 2026  
**Status:** Active Development

---

## Executive Summary

The Vercel AI Gateway VS Code Extension bridges Vercel's AI infrastructure directly into the developer's primary workspace. By implementing VS Code's Language Model API, the extension transforms VS Code's native chat interface into a unified gateway for accessing GPT-4o, Claude, Gemini, and every model available through Vercel AI Gateway—without leaving the editor.

This extension represents a strategic opportunity: **making Vercel the invisible infrastructure layer that powers AI-assisted development across the industry's most popular code editor.**

---

## Strategic Alignment with Vercel

### Vercel's AI Gateway Vision

Vercel AI Gateway provides a unified API for accessing multiple AI providers with enterprise-grade features:

- **Provider abstraction** — One API, many models
- **Usage tracking and cost management** — Centralized billing across providers
- **Rate limiting and caching** — Enterprise controls for AI consumption
- **OIDC authentication** — Secure, project-scoped access tokens

### How This Extension Amplifies That Vision

| Vercel Goal              | Extension Contribution                                                     |
| ------------------------ | -------------------------------------------------------------------------- |
| **Unified AI Access**    | Developers access OpenAI, Anthropic, Google, Mistral through one interface |
| **Developer Experience** | AI assistance lives where developers already work—inside VS Code           |
| **Platform Stickiness**  | Teams that adopt the extension become Vercel AI Gateway customers          |
| **Enterprise Adoption**  | OIDC auth + model allowlists enable IT-controlled AI access                |
| **Usage Visibility**     | All AI consumption flows through Vercel's metering infrastructure          |

---

## What the Extension Does

### Core Capability: Language Model Provider

The extension registers as a **Language Model Chat Provider** in VS Code, implementing the `vscode.lm` API. This means:

1. **Native Integration** — Models appear in VS Code's built-in model picker alongside GitHub Copilot
2. **Zero UI Overhead** — No custom chat panels; uses VS Code's native chat infrastructure
3. **Tool Compatibility** — Works with any VS Code extension that uses the Language Model API

```
┌────────────────────────────────────────────────────────────┐
│                      VS Code Chat UI                       │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Model Selector: [Vercel AI Gateway: claude-sonnet ▼]│   │
│  └─────────────────────────────────────────────────────┘   │
│                            │                               │
│                            ▼                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │        Vercel AI Gateway Extension                  │   │
│  │  • Message conversion (VS Code ↔ AI SDK format)     │   │
│  │  • Token estimation (tiktoken + adaptive correction)│   │
│  │  • Streaming response handling                      │   │
│  │  • Tool call forwarding                             │   │
│  └─────────────────────────────────────────────────────┘   │
│                            │                               │
│                            ▼                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │           Vercel AI Gateway (Cloud)                 │   │
│  │  • Model routing (openai/gpt-4o → OpenAI API)       │   │
│  │  • Authentication (API key or OIDC)                 │   │
│  │  • Usage metering and rate limiting                 │   │
│  └─────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
```

### Model Discovery and Capabilities

The extension dynamically fetches available models from `/v1/models` and maps them to VS Code's model metadata format:

| API Field        | VS Code Field     | Purpose                                                        |
| ---------------- | ----------------- | -------------------------------------------------------------- |
| `id`             | `id`              | Unique model identifier (`anthropic:claude-sonnet-4-20250514`) |
| `name`           | `name`            | Human-readable name                                            |
| `context_window` | `maxInputTokens`  | Context limit for token validation                             |
| `max_tokens`     | `maxOutputTokens` | Response length limit                                          |
| `tags[]`         | `capabilities`    | Feature detection (vision, tool-use, reasoning)                |

**Capability Detection:** The extension parses model tags to advertise accurate capabilities:

```typescript
capabilities: {
  imageInput: tags.includes("vision") || tags.includes("multimodal"),
  toolCalling: tags.includes("tool-use") || tags.includes("function_calling"),
  reasoning: tags.includes("reasoning") || tags.includes("extended-thinking"),
  webSearch: tags.includes("web-search") || tags.includes("grounding"),
}
```

This enables VS Code to:

- Show only vision-capable models when the user attaches an image
- Filter to tool-capable models when extensions require function calling
- Surface reasoning models for complex problem-solving tasks

### Model Identity Parsing

A key innovation is parsing model IDs to extract semantic `family` and `version`:

```
openai:gpt-4o-2024-11-20
  ↓
provider: "openai"
family:   "gpt-4o"
version:  "2024-11-20"
```

This enables VS Code's model selectors (`@family:gpt-4o`) to work correctly and helps users understand which model variant they're using.

---

## Authentication Architecture

### Dual Authentication Modes

```
┌───────────────────────────────────────────────────────┐
│              Authentication Provider                  │
│                                                       │
│  ┌──────────────────┐    ┌──────────────────┐         │
│  │   API Key Mode   │    │    OIDC Mode     │         │
│  │  ─────────────── │    │  ─────────────── │         │
│  │  • Manual entry  │    │  • Vercel CLI    │         │
│  │  • vck_* format  │    │  • Auto-refresh  │         │
│  │  • Personal use  │    │  • Project-scoped│         │
│  └──────────────────┘    └──────────────────┘         │
│           │                       │                   │
│           └───────────┬───────────┘                   │
│                       ▼                               │
│          ┌────────────────────────┐                   │
│          │   VS Code Secrets API  │                   │
│          │   (Secure storage)     │                   │
│          └────────────────────────┘                   │
└───────────────────────────────────────────────────────┘
```

### API Key Authentication

- Simple onboarding: enter `vck_*` key once
- Stored securely in VS Code's secrets storage
- Ideal for individual developers

### OIDC Authentication

- Leverages existing Vercel CLI login (`vercel login`)
- Project-scoped tokens with automatic refresh
- Enterprise-ready: tokens tied to team/project permissions
- 15-minute refresh margin ensures uninterrupted sessions

**Enterprise Value:** OIDC enables IT teams to:

- Control which projects can access AI Gateway
- Audit AI usage per team/project
- Revoke access without distributing new API keys

---

## Token Management System

### The Token Counting Challenge

VS Code asks the extension "how many tokens is this message?" to decide whether to compact/truncate context before sending. Accurate estimates are critical:

- **Overestimate:** Premature truncation loses valuable context
- **Underestimate:** API rejects request for exceeding limits

### Multi-Layer Token Estimation

```
┌─────────────────────────────────────────────────────────┐
│                  Token Counting Pipeline                │
│                                                         │
│  1. Cache Lookup ────────────────────────────────────── │
│     │ Check for API actuals from previous requests      │
│     │ If found: return cached count + 2% margin         │
│     ▼                                                   │
│  2. Tiktoken Estimation ─────────────────────────────── │
│     │ Use js-tiktoken with model-appropriate encoding   │
│     │ o200k_base for GPT-4o/o1, cl100k_base for others  │
│     ▼                                                   │
│  3. Character Fallback ──────────────────────────────── │
│     │ For models without tiktoken support               │
│     │ ~3.5 characters per token (configurable)          │
│     ▼                                                   │
│  4. Adaptive Correction ─────────────────────────────── │
│     │ Compare estimates to API actuals after response   │
│     │ Exponential moving average: 0.7 * old + 0.3 * new │
│     ▼                                                   │
│  5. Safety Margin ───────────────────────────────────── │
│     5% for tiktoken, 10% for character fallback         │
└─────────────────────────────────────────────────────────┘
```

### Per-Message Caching

After each API response, the extension distributes the actual input token count across messages proportionally:

```typescript
// API returns: totalInputTokens = 15000
// Our estimates: [3000, 5000, 7000] (3 messages)
// Distributed actuals: [3000, 5000, 7000] (proportional)
```

This means if the user edits message 2, messages 1 and 3 still have cached ground-truth counts.

---

## Streaming and Tool Calling

### Full-Stream Processing

The extension uses Vercel AI SDK's `fullStream` (not `toUIMessageStream`) to access all event types:

```typescript
for await (const chunk of response.fullStream) {
  switch (chunk.type) {
    case "text-delta":
      // Emit text to VS Code chat
      progress.report(new LanguageModelTextPart(chunk.textDelta));
      break;

    case "reasoning-delta":
      // NOTE: VS Code has no stable "thinking" part type yet
      // Currently suppressed; see docs/specs/lm-provider-stream-semantics.md
      // Future: progress.report(new LanguageModelThinkingPart(chunk.delta));
      break;

    case "tool-call":
      // Forward to VS Code for execution
      progress.report(new LanguageModelToolCallPart(...));
      break;

    case "file":
      // Handle generated images/files
      progress.report(new LanguageModelDataPart(...));
      break;
  }
}
```

**Stream Semantics:** For detailed specification of how parts should be emitted and interpreted, see [LM Provider Stream Semantics](../specs/lm-provider-stream-semantics.md).

### Tool Calling Flow

```
User Message → Extension → AI Gateway → Model
                                          │
                              "Call tool X with args"
                                          │
                                          ▼
Extension ← AI Gateway ← ToolCallPart ────┘
    │
    │ Forward to VS Code
    ▼
VS Code executes tool (e.g., file read, terminal command)
    │
    │ ToolResultPart
    ▼
Extension → AI Gateway → Model continues response
```

**Key Design Decision:** Tools are defined _without_ execute functions. This lets tool calls flow through to VS Code, which handles execution and sends results back. The extension is a transparent bridge.

---

## Configuration System

### User-Facing Settings

| Setting                   | Purpose                          | Default                        |
| ------------------------- | -------------------------------- | ------------------------------ |
| `endpoint`                | AI Gateway URL (for self-hosted) | `https://ai-gateway.vercel.sh` |
| `timeout`                 | Request timeout                  | 30s                            |
| `models.allowlist`        | Restrict to specific models      | `[]` (all)                     |
| `models.denylist`         | Hide specific models             | `[]`                           |
| `models.default`          | Pre-select a model               | `""`                           |
| `reasoning.defaultEffort` | For o1/o3 models                 | `"medium"`                     |
| `tokens.estimationMode`   | Conservative/balanced/aggressive | `"balanced"`                   |
| `logging.level`           | Debug verbosity                  | `"warn"`                       |

### Enterprise Configuration Example

```json
{
  "vercelAiGateway.endpoint": "https://ai-gateway.acme-corp.vercel.app",
  "vercelAiGateway.models.allowlist": ["anthropic/claude-*", "openai/gpt-4o"],
  "vercelAiGateway.models.denylist": ["*/gpt-3.5-*"]
}
```

This allows IT to:

- Route through a corporate AI Gateway deployment
- Restrict to approved models only
- Block deprecated or non-compliant models

---

## Competitive Positioning

### vs. GitHub Copilot

| Aspect          | GitHub Copilot           | Vercel AI Gateway Extension |
| --------------- | ------------------------ | --------------------------- |
| Models          | GPT-4o, Claude (limited) | All Vercel Gateway models   |
| Pricing         | Per-seat subscription    | Usage-based via Vercel      |
| Provider Choice | GitHub-controlled        | User/org controlled         |
| Self-hosting    | No                       | Yes (AI Gateway)            |
| Tool Support    | Copilot ecosystem        | VS Code LM API ecosystem    |

**Value Proposition:** "Use Copilot's interface with your choice of models and Vercel's billing."

### vs. Continue.dev / Cody

| Aspect      | Continue/Cody           | Vercel AI Gateway Extension |
| ----------- | ----------------------- | --------------------------- |
| Integration | Custom UI panels        | Native VS Code chat         |
| Setup       | Configure each provider | One Vercel auth             |
| Billing     | Per-provider            | Unified Vercel billing      |
| Enterprise  | Variable                | OIDC + Vercel Teams         |

**Value Proposition:** "No separate UI, no provider configuration—just Vercel."

---

## Future Roadmap

### Near-Term (Q1 2026)

- [ ] **Per-model enrichment** — Fetch detailed capabilities from `/v1/models/{id}/endpoints`
- [ ] **Model favorites** — Pin frequently-used models
- [ ] **Usage dashboard** — Show token consumption in status bar

### Medium-Term (Q2-Q3 2026)

- [ ] **Conversation history** — Persist chats across sessions
- [ ] **Custom system prompts per model** — Model-specific personalities
- [ ] **Prompt templates** — Quick-access prompt library
- [ ] **Cost estimation** — Show estimated cost before sending

### Long-Term Vision

- [ ] **Agent mode** — Multi-step task execution with tool orchestration
- [ ] **Team shared prompts** — Sync prompts across organization via Vercel
- [ ] **AI Gateway Analytics integration** — Surface usage insights in VS Code

---

## Success Metrics

| Metric                 | Target             | Rationale            |
| ---------------------- | ------------------ | -------------------- |
| Marketplace installs   | 10,000 in 6 months | Developer adoption   |
| Weekly active users    | 3,000              | Stickiness indicator |
| Avg. requests/user/day | 15+                | Engagement depth     |
| OIDC vs API key ratio  | 30% OIDC           | Enterprise adoption  |
| Model diversity        | 5+ providers used  | Gateway value proven |

---

## Conclusion

The Vercel AI Gateway VS Code Extension is more than a convenience feature—it's a strategic distribution channel for Vercel's AI infrastructure. By meeting developers where they work and providing seamless access to the best AI models through a single authentication, Vercel positions itself as the default AI platform for modern development teams.

The extension's deep integration with VS Code's native APIs, sophisticated token management, and enterprise-ready authentication make it a compelling alternative to fragmented AI tooling. As AI becomes central to software development, this extension ensures Vercel is the infrastructure powering that transformation.

---

_For technical implementation details, see [RFC 008: High-Fidelity Model Mapping](../rfcs/008-high-fidelity-model-mapping.md)._
