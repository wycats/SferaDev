---
stage: 1
---

# RFC 005: Configuration & Logging

**Status:** Ready for Review  
**Author:** Vercel AI Team  
**Created:** 2026-01-27  
**Updated:** 2026-01-27

## Summary

Define the configuration schema for the Vercel VS Code extension, along with model filtering and structured logging. This RFC provides the foundation that authentication and telemetry features build upon.

## Motivation

Enterprise and advanced users need fine-grained control over endpoints, models, timeouts, and verbosity. Consolidating configuration and logging ensures a consistent configuration surface for the rest of the system.

## Detailed Design

### Configuration Schema

```json
{
  "contributes": {
    "configuration": {
      "title": "Vercel AI",
      "properties": {
        "vercel.ai.gateway.endpoint": {
          "type": "string",
          "default": "https://ai-gateway.vercel.sh",
          "description": "AI Gateway endpoint URL. Change for self-hosted or regional deployments.",
          "scope": "machine-overridable"
        },
        "vercel.ai.gateway.timeout": {
          "type": "number",
          "default": 60000,
          "description": "Request timeout in milliseconds.",
          "minimum": 5000,
          "maximum": 300000
        },
        "vercel.ai.authentication.method": {
          "type": "string",
          "enum": ["apiKey", "oidc"],
          "default": "apiKey",
          "description": "Authentication method to use.",
          "enumDescriptions": [
            "Use an API key stored in VS Code's secure storage",
            "Use OIDC token from configured identity provider"
          ]
        },
        "vercel.ai.authentication.oidc.issuer": {
          "type": "string",
          "description": "OIDC issuer URL for enterprise authentication."
        },
        "vercel.ai.authentication.oidc.clientId": {
          "type": "string",
          "description": "OIDC client ID."
        },
        "vercel.ai.authentication.oidc.scopes": {
          "type": "array",
          "items": { "type": "string" },
          "default": ["openid", "profile"],
          "description": "OIDC scopes to request."
        },
        "vercel.ai.models.default": {
          "type": "string",
          "default": "",
          "description": "Default model ID (e.g., 'anthropic/claude-sonnet-4-20250514'). Leave empty to show model picker.",
          "examples": [
            "anthropic/claude-sonnet-4-20250514",
            "openai/gpt-4.1",
            "google/gemini-2.5-pro"
          ]
        },
        "vercel.ai.models.allowlist": {
          "type": "array",
          "items": { "type": "string" },
          "default": [],
          "description": "Restrict available models to this list. Empty means all models are available.",
          "examples": [["anthropic/claude-sonnet-4-20250514", "openai/gpt-4.1"]]
        },
        "vercel.ai.models.denylist": {
          "type": "array",
          "items": { "type": "string" },
          "default": [],
          "description": "Hide these models from the model picker."
        },
        "vercel.ai.models.fallbacks": {
          "type": "object",
          "additionalProperties": {
            "type": "array",
            "items": { "type": "string" }
          },
          "default": {},
          "description": "Fallback models for each primary model.",
          "examples": [
            {
              "anthropic/claude-sonnet-4-20250514": [
                "openai/gpt-4.1",
                "google/gemini-2.5-pro"
              ]
            }
          ]
        },
        "vercel.ai.tokens.estimationMode": {
          "type": "string",
          "enum": ["conservative", "balanced", "aggressive"],
          "default": "conservative",
          "description": "Token estimation strategy.",
          "enumDescriptions": [
            "Overestimate tokens to avoid context overflow (recommended)",
            "Balance between accuracy and safety",
            "Underestimate tokens for maximum context usage"
          ]
        },
        "vercel.ai.tokens.charsPerToken": {
          "type": "number",
          "default": 3.5,
          "description": "Characters per token for estimation. Lower = more conservative.",
          "minimum": 2,
          "maximum": 6
        },
        "vercel.ai.reasoning.enabled": {
          "type": "boolean",
          "default": true,
          "description": "Show model reasoning/thinking when available."
        },
        "vercel.ai.reasoning.defaultEffort": {
          "type": "string",
          "enum": ["low", "medium", "high"],
          "default": "medium",
          "description": "Default reasoning effort level for models that support it."
        },
        "vercel.ai.systemPrompt.enabled": {
          "type": "boolean",
          "default": false,
          "description": "Inject a system prompt to all requests."
        },
        "vercel.ai.systemPrompt.message": {
          "type": "string",
          "default": "You are being accessed through Vercel AI Gateway in VS Code.",
          "description": "System prompt message to inject."
        },
        "vercel.ai.telemetry.enabled": {
          "type": "boolean",
          "default": false,
          "description": "Send anonymous usage telemetry to help improve the extension."
        },
        "vercel.ai.telemetry.includeModelUsage": {
          "type": "boolean",
          "default": true,
          "description": "Include model and token usage in telemetry (requires telemetry.enabled)."
        },
        "vercel.ai.logging.level": {
          "type": "string",
          "enum": ["off", "error", "warn", "info", "debug"],
          "default": "warn",
          "description": "Logging verbosity level."
        },
        "vercel.ai.logging.outputChannel": {
          "type": "boolean",
          "default": true,
          "description": "Show logs in 'Vercel AI' output channel."
        }
      }
    }
  }
}
```

### Model Filtering

```typescript
// src/models/filter.ts

import * as vscode from "vscode";
import type { LanguageModelChatInformation } from "vscode";

export interface ModelFilterConfig {
  allowlist: string[];
  denylist: string[];
  fallbacks: Record<string, string[]>;
}

export class ModelFilter {
  private config: ModelFilterConfig;

  constructor() {
    this.config = this.loadConfig();

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vercel.ai.models")) {
        this.config = this.loadConfig();
      }
    });
  }

  private loadConfig(): ModelFilterConfig {
    const config = vscode.workspace.getConfiguration("vercel.ai.models");
    return {
      allowlist: config.get("allowlist", []),
      denylist: config.get("denylist", []),
      fallbacks: config.get("fallbacks", {}),
    };
  }

  filterModels(
    models: LanguageModelChatInformation[],
  ): LanguageModelChatInformation[] {
    let filtered = models;

    if (this.config.allowlist.length > 0) {
      filtered = filtered.filter((m) =>
        this.config.allowlist.some((pattern) =>
          this.matchesPattern(m.id, pattern),
        ),
      );
    }

    if (this.config.denylist.length > 0) {
      filtered = filtered.filter(
        (m) =>
          !this.config.denylist.some((pattern) =>
            this.matchesPattern(m.id, pattern),
          ),
      );
    }

    return filtered;
  }

  getFallbacks(modelId: string): string[] {
    return this.config.fallbacks[modelId] || [];
  }

  private matchesPattern(modelId: string, pattern: string): boolean {
    if (pattern.includes("*")) {
      const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
      return regex.test(modelId);
    }
    return modelId === pattern;
  }
}
```

### Logging

```typescript
// src/utils/logger.ts

import * as vscode from "vscode";

export type LogLevel = "off" | "error" | "warn" | "info" | "debug";

const LOG_LEVELS: Record<LogLevel, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export class Logger {
  private outputChannel: vscode.OutputChannel | null = null;
  private level: LogLevel = "warn";

  constructor() {
    this.loadConfig();

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vercel.ai.logging")) {
        this.loadConfig();
      }
    });
  }

  private loadConfig(): void {
    const config = vscode.workspace.getConfiguration("vercel.ai.logging");
    this.level = config.get("level", "warn");

    const useOutputChannel = config.get("outputChannel", true);
    if (useOutputChannel && !this.outputChannel) {
      this.outputChannel = vscode.window.createOutputChannel("Vercel AI");
    } else if (!useOutputChannel && this.outputChannel) {
      this.outputChannel.dispose();
      this.outputChannel = null;
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] <= LOG_LEVELS[this.level];
  }

  private log(level: LogLevel, message: string, ...args: unknown[]): void {
    if (!this.shouldLog(level)) return;

    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
    const formatted = `${prefix} ${message}`;

    switch (level) {
      case "error":
        console.error(formatted, ...args);
        break;
      case "warn":
        console.warn(formatted, ...args);
        break;
      case "info":
        console.info(formatted, ...args);
        break;
      case "debug":
        console.debug(formatted, ...args);
        break;
    }

    if (this.outputChannel) {
      const argsStr = args.length > 0 ? " " + JSON.stringify(args) : "";
      this.outputChannel.appendLine(formatted + argsStr);
    }
  }

  error(message: string, ...args: unknown[]): void {
    this.log("error", message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.log("warn", message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.log("info", message, ...args);
  }

  debug(message: string, ...args: unknown[]): void {
    this.log("debug", message, ...args);
  }

  show(): void {
    this.outputChannel?.show();
  }

  dispose(): void {
    this.outputChannel?.dispose();
  }
}

export const logger = new Logger();
```

## Drawbacks

1. **Configuration complexity**: Many options can overwhelm users.
2. **Settings sprawl**: Requires careful documentation and defaults.

## Alternatives

### Alternative 1: Minimal Configuration

**Rejected because:** VS Code-specific settings (logging, token estimation) can’t be configured elsewhere.

## Unresolved Questions

1. **Settings sync**: Should these settings sync across machines?
2. **Managed settings**: How to push settings from enterprise admin?

## Implementation Plan

1. Implement configuration schema and validation.
2. Add model filtering and logging systems.
3. Document configuration settings and defaults.
