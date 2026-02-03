# RFC 006: Token Estimation & Message Conversion

**Status:** Implemented  
**Author:** Vercel AI Team  
**Created:** 2026-01-27  
**Updated:** 2026-01-27

## Summary

Extract the hybrid token estimation, message conversion utilities, and MIME handling into a reusable package module. This includes `HybridTokenEstimator`, message conversion utilities for tool mapping, and data part MIME validation.

## Motivation

The extension relies on a complex mix of estimation, tool mapping, and MIME handling logic to translate VS Code messages into AI SDK messages and to keep context limits accurate. Centralizing this logic in a package keeps behavior consistent across consumers.

## Detailed Design

### Module Structure

```
@vercel/ai-gateway-vscode/
├── src/
│   ├── tokens/
│   │   ├── estimator.ts            # HybridTokenEstimator class
│   │   ├── image-tokens.ts         # Image token estimation
│   │   └── types.ts                # Token types
│   ├── messages/
│   │   ├── converter.ts            # Message conversion utilities
│   │   ├── tool-mapping.ts         # Tool call/result mapping
│   │   └── types.ts                # Message types
│   └── utils/
│       └── mime.ts                 # MIME type validation
```

### HybridTokenEstimator

```typescript
// src/tokens/estimator.ts
import type {
  LanguageModelChatMessage,
  LanguageModelChatInformation,
} from "vscode";

export interface TokenEstimatorOptions {
  /** Characters per token for text estimation (default: 3.5) */
  charsPerToken?: number;
  /** Whether to use conservative estimates (default: true) */
  conservative?: boolean;
  /** Provider-specific overrides */
  providerOverrides?: Record<string, { charsPerToken: number }>;
}

export interface EstimationResult {
  tokens: number;
  method: "actual" | "hybrid" | "estimated";
  confidence: number; // 0-1
}

export class HybridTokenEstimator {
  private options: Required<TokenEstimatorOptions>;
  private lastActualInputTokens: number | null = null;
  private lastMessageCount: number = 0;
  private correctionFactor: number = 1.0;

  constructor(options: TokenEstimatorOptions = {}) {
    this.options = {
      charsPerToken: options.charsPerToken ?? 3.5,
      conservative: options.conservative ?? true,
      providerOverrides: options.providerOverrides ?? {
        anthropic: { charsPerToken: 4.0 },
        openai: { charsPerToken: 3.5 },
        google: { charsPerToken: 4.0 },
      },
    };
  }

  estimateMessage(
    model: LanguageModelChatInformation,
    message: LanguageModelChatMessage,
  ): number {
    const charsPerToken = this.getCharsPerToken(model);
    let tokens = 0;

    for (const part of message.content) {
      tokens += this.estimatePart(model, part, charsPerToken);
    }

    return Math.ceil(tokens * (this.options.conservative ? 1.1 : 1.0));
  }

  estimateConversation(
    model: LanguageModelChatInformation,
    messages: readonly LanguageModelChatMessage[],
  ): EstimationResult {
    if (
      this.lastActualInputTokens !== null &&
      messages.length > this.lastMessageCount &&
      this.lastMessageCount > 0
    ) {
      const newMessages = messages.slice(this.lastMessageCount);
      let newTokens = 0;
      for (const msg of newMessages) {
        newTokens += this.estimateMessage(model, msg);
      }
      newTokens += newMessages.length * 4;

      return {
        tokens: this.lastActualInputTokens + newTokens,
        method: "hybrid",
        confidence: 0.85,
      };
    }

    let total = 0;
    for (const msg of messages) {
      total += this.estimateMessage(model, msg);
    }
    total += messages.length * 4;

    return {
      tokens: Math.ceil(total * this.correctionFactor),
      method: "estimated",
      confidence: 0.7,
    };
  }

  calibrate(
    actualInputTokens: number,
    messageCount: number,
    estimatedTokens: number,
  ): void {
    this.lastActualInputTokens = actualInputTokens;
    this.lastMessageCount = messageCount;

    if (estimatedTokens > 0) {
      const newFactor = actualInputTokens / estimatedTokens;
      this.correctionFactor = this.correctionFactor * 0.7 + newFactor * 0.3;
    }
  }

  reset(): void {
    this.lastActualInputTokens = null;
    this.lastMessageCount = 0;
  }

  // ... type guards and image token estimation
}
```

### Message Conversion Utilities

```typescript
// src/messages/converter.ts
import type { ModelMessage } from "ai";
import type { LanguageModelChatMessage } from "vscode";

export interface ConversionOptions {
  /** How to handle images in non-user messages */
  imageInNonUserMessage?: "placeholder" | "skip" | "error";
  /** Logger for warnings */
  logger?: { warn: (msg: string) => void };
}

export function convertMessages(
  messages: readonly LanguageModelChatMessage[],
  options: ConversionOptions = {},
): ModelMessage[] {
  const toolNameMap = buildToolNameMap(messages);
  const result = messages
    .flatMap((msg) => convertSingleMessage(msg, toolNameMap, options))
    .filter(isValidMessage);

  fixSystemMessages(result);
  return result;
}
```

Tool call/result mapping is performed in a first pass to ensure all `toolCallId → toolName` pairs are available for tool-result construction.

### MIME Handling

The `utils/mime.ts` helper validates MIME types and selects the appropriate `LanguageModelDataPart` constructor:

- `LanguageModelDataPart.image(...)` for image types
- `LanguageModelDataPart.json(...)` for structured JSON
- `LanguageModelDataPart.text(...)` for plain or formatted text

This ensures consistent handling of file and data chunks across all VS Code integrations.

## Implementation Notes

Implemented in packages/vscode-ai-gateway/src/provider.ts, including the hybrid token estimation flow, message conversion utilities, and MIME/data part handling that feed the VS Code language model provider.

## Drawbacks

1. **Package surface area**: Additional APIs increase documentation and testing scope.
2. **Calibration drift**: Token estimation accuracy depends on usage calibration.

## Alternatives

### Alternative 1: Keep Utilities in Extension

**Rejected because:** Duplication across integrations would be costly and error-prone.

## Unresolved Questions

1. **Provider overrides**: Should overrides be configurable via extension settings?
2. **MIME coverage**: Should additional MIME types be explicitly supported?

## Implementation Plan

1. Extract token estimator and message conversion utilities.
2. Add unit tests for tool mapping, token estimation, and MIME handling.
3. Update extension imports to use the package.
