# RFC 005c: Telemetry & Privacy

**Status:** Draft  
**Author:** Vercel AI Team  
**Created:** 2026-01-27  
**Updated:** 2026-01-27

## Summary

Define the telemetry schema, opt-in flow, and privacy handling for the VS Code extension, including data minimization and retention policies.

## Motivation

Telemetry is required to diagnose issues, understand usage patterns, and monitor model cost and performance. It must remain opt-in and respect VS Code’s global telemetry settings.

## Detailed Design

### Telemetry Schema

```typescript
// src/telemetry/index.ts

export interface TelemetryEvent {
  name: string;
  properties?: Record<string, string>;
  measurements?: Record<string, number>;
}
```

Telemetry events include:

- `model_request` (model ID, provider, input/output tokens, duration)
- `error` (error name, message, context)
- `token_estimation` (estimated vs actual accuracy)

### Opt-In Flow

1. User enables telemetry via `vercel.ai.telemetry.enabled`.
2. The extension respects `vscode.env.isTelemetryEnabled` and sends nothing if it is disabled.
3. Users can disable telemetry at any time in settings.

### Data Handling

The reporter enriches events with:

- `sessionId` (random per extension session)
- `extensionVersion`
- `vscodeVersion`
- `platform`

If `vercel.ai.telemetry.includeModelUsage` is `false`, model IDs and token counts are removed from payloads.

### Retention Policy

Telemetry data is retained for **90 days** for diagnostics and aggregate reporting. After the retention window, events are deleted or aggregated without user-identifiable fields.

### Reference Implementation

```typescript
// src/telemetry/index.ts

import * as vscode from "vscode";

export class TelemetryReporter {
  private enabled: boolean = false;
  private includeModelUsage: boolean = true;
  private sessionId: string;

  constructor(private context: vscode.ExtensionContext) {
    this.sessionId = crypto.randomUUID();
    this.loadConfig();

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vercel.ai.telemetry")) {
        this.loadConfig();
      }
    });
  }

  private loadConfig(): void {
    const config = vscode.workspace.getConfiguration("vercel.ai.telemetry");
    this.enabled = config.get("enabled", false);
    this.includeModelUsage = config.get("includeModelUsage", true);
  }

  sendEvent(event: { name: string; properties?: Record<string, string>; measurements?: Record<string, number> }): void {
    if (!this.enabled) return;
    if (vscode.env.isTelemetryEnabled === false) return;

    const payload = {
      ...event,
      properties: {
        ...event.properties,
        sessionId: this.sessionId,
        extensionVersion: this.context.extension.packageJSON.version,
        vscodeVersion: vscode.version,
        platform: process.platform,
      },
    };

    if (!this.includeModelUsage && event.measurements) {
      delete payload.measurements?.inputTokens;
      delete payload.measurements?.outputTokens;
      delete payload.properties?.modelId;
    }

    this.send(payload).catch(console.error);
  }

  private async send(payload: unknown): Promise<void> {
    const config = vscode.workspace.getConfiguration("vercel.ai.logging");
    if (config.get("level") === "debug") {
      console.debug("[Telemetry]", payload);
    }
  }
}
```

## Drawbacks

1. **Perception risk**: Telemetry can reduce trust without clear opt-in messaging.
2. **Operational overhead**: Requires a secure, reliable telemetry endpoint.

## Alternatives

### Alternative 1: No Telemetry

**Rejected because:** Limits observability for support and quality improvements.

## Unresolved Questions

1. **Telemetry endpoint**: Where should telemetry data be sent?
2. **Aggregation strategy**: How should aggregated metrics be reported?

## Implementation Plan

1. Implement telemetry reporter and configuration guards.
2. Add documentation and opt-in messaging.
3. Publish retention policy in the privacy documentation.
