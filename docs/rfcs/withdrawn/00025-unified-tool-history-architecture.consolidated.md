---
title: Unified Tool History Architecture
stage: 0
feature: tool-history
exo:
  tool: exo rfc create
  protocol: 1
---

# RFC 00025: Unified Tool History Architecture

**Status**: Stage 0 (Draft)  
**Created**: 2025-01-30  
**Related**: RFC 00024, RFC 013 (Tool Call Truncation)

## Summary

Unify tool history handling under `ToolHistoryManager` with a **strategy pattern** to switch between text-embed (current workaround) and native (future) rendering. This eliminates divergence between truncation logic and translation logic.

## Problem Statement

### Current State: Separate Concerns That Have Drifted

The codebase has **two independent implementations** for handling tool history:

| Component              | Location                | Purpose                                     | Used?  |
| ---------------------- | ----------------------- | ------------------------------------------- | ------ |
| **Inline translation** | `openresponses-chat.ts` | Skip tool calls, embed results as user text | ✅ Yes |
| **ToolHistoryManager** | `tool-history.ts`       | Truncation, summarization, HTML comments    | ❌ No  |

**Evidence of drift:**

```typescript
// openresponses-chat.ts - inline handling
} else if (part instanceof LanguageModelToolCallPart) {
  // CRITICAL: `function_call` is NOT a valid input item...
  // (skips entirely)
} else if (part instanceof LanguageModelToolResultPart) {
  // Emit as user text: `Context (tool result):\n${output}`
}
```

```typescript
// tool-history.ts - completely separate formatting
callText: `<!-- prior-tool: ${entry.name} | id: ${entry.callId} | args: ${argsStr} -->`,
resultText: `<!-- prior-tool-result: ${entry.callId} -->\n${entry.result}`,
```

**Problems with separation:**

1. **Dead code**: `ToolHistoryManager` is never called from translation path
2. **Config ignored**: `maxToolHistoryLength`, `toolHistorySummarizationModel` are dead
3. **Divergence risk**: Future changes to one won't update the other
4. **Duplication**: Two different text formats for the same concept

### Design Goal

**Single source of truth** for tool history with **swappable rendering strategies**:

- **Text-embed strategy**: Current behavior (results as user messages)
- **Native strategy**: Emit `function_call` + `function_call_output` items (when Gateway supports it)

## Proposal

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                  openresponses-chat.ts                       │
│                                                              │
│  1. Extract tool pairs from VS Code messages                 │
│  2. Feed to ToolHistoryManager                               │
│  3. Get rendered items via strategy                          │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────┐
│                  ToolHistoryManager                          │
│  (existing, enhanced)                                        │
│                                                              │
│  - addToolCall(callId, name, args, result)                   │
│  - getCompactedHistory() → CompactedHistory                  │
│  - renderAsItems(strategy) → ItemParam[]  ← NEW              │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────┐
│            ToolHistoryStrategy (interface)                   │
│                                                              │
│  renderEntry(entry: FormattedToolEntry): ItemParam[]         │
│  renderSummary(summary: string): ItemParam[]                 │
└──────────────┬──────────────────────┬───────────────────────┘
               │                      │
               ▼                      ▼
┌──────────────────────┐   ┌──────────────────────┐
│  TextEmbedStrategy   │   │   NativeStrategy     │
│  (current behavior)  │   │   (future)           │
│                      │   │                      │
│  Renders as:         │   │  Renders as:         │
│  - user message      │   │  - function_call     │
│    with tool result  │   │  - function_call_out │
└──────────────────────┘   └──────────────────────┘
```

### Phase 1: Strategy Interface

**New file:** `src/provider/tool-history-strategy.ts`

```typescript
import type { ItemParam } from "openresponses-client";
import type { FormattedToolEntry } from "./tool-history.js";

/**
 * Strategy for rendering tool history into OpenResponses input items.
 */
export interface ToolHistoryStrategy {
  /** Render a single tool call/result pair as input items */
  renderEntry(entry: FormattedToolEntry): ItemParam[];

  /** Render the summary of older tool calls */
  renderSummary(summary: string): ItemParam[];

  /** Strategy identifier for logging */
  readonly name: string;
}

/**
 * Text-embed strategy: Current behavior.
 * Emits tool results as user messages.
 * Tool calls are omitted to prevent mimicry.
 */
export class TextEmbedStrategy implements ToolHistoryStrategy {
  readonly name = "text-embed";

  renderEntry(entry: FormattedToolEntry): ItemParam[] {
    // Skip the callText (tool call) - matches current behavior
    // Emit resultText as user message
    return [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Context (tool result):\n${this.stripCommentMarkers(entry.resultText)}`,
          },
        ],
      },
    ];
  }

  renderSummary(summary: string): ItemParam[] {
    if (!summary) return [];
    return [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: summary }],
      },
    ];
  }

  private stripCommentMarkers(text: string): string {
    return text.replace(/<!-- prior-tool-result: \S+ -->\n?/, "");
  }
}

/**
 * Native strategy: Emit function_call + function_call_output items.
 * Use when Gateway supports function_call input.
 */
export class NativeStrategy implements ToolHistoryStrategy {
  readonly name = "native";

  renderEntry(entry: FormattedToolEntry): ItemParam[] {
    // Parse from HTML comment format
    const callMatch = entry.callText.match(
      /prior-tool: (\S+) \| id: (\S+) \| args: (.+) -->/,
    );
    if (!callMatch) {
      // Fallback to text-embed if parsing fails
      return new TextEmbedStrategy().renderEntry(entry);
    }

    const [, name, callId, argsStr] = callMatch;
    const resultText = entry.resultText.replace(
      /<!-- prior-tool-result: \S+ -->\n?/,
      "",
    );

    return [
      {
        type: "function_call",
        call_id: callId,
        name,
        arguments: argsStr,
      },
      {
        type: "function_call_output",
        call_id: callId,
        output: resultText,
      },
    ];
  }

  renderSummary(summary: string): ItemParam[] {
    // Summaries have no native equivalent - use text
    return new TextEmbedStrategy().renderSummary(summary);
  }
}
```

### Phase 2: Enhance ToolHistoryManager

Add new method to existing `tool-history.ts`:

```typescript
import type { ItemParam } from "openresponses-client";
import type { ToolHistoryStrategy } from "./tool-history-strategy.js";
import { TextEmbedStrategy } from "./tool-history-strategy.js";

// In ToolHistoryManager class:

/**
 * Render tool history as OpenResponses input items.
 *
 * @param strategy - Rendering strategy (default: TextEmbedStrategy)
 * @returns Array of ItemParam ready for OpenResponses input
 */
renderAsItems(
  strategy: ToolHistoryStrategy = new TextEmbedStrategy()
): ItemParam[] {
  const compacted = this.getCompactedHistory();
  const items: ItemParam[] = [];

  // Add summary if present
  if (compacted.summary) {
    items.push(...strategy.renderSummary(compacted.summary));
  }

  // Add recent calls
  for (const entry of compacted.recentCalls) {
    items.push(...strategy.renderEntry(entry));
  }

  this.logger.trace(
    `[ToolHistory] Rendered ${items.length} items via ${strategy.name} strategy`
  );

  return items;
}
```

### Phase 3: Wire into openresponses-chat.ts

**Key changes to message translation:**

```typescript
// In provideLanguageModelResponse2, before translation loop:

// Step 1: Extract tool history from messages
const toolHistory = new ToolHistoryManager(
  {
    recentCallsToKeep: config.maxToolHistoryLength ?? 6,
    truncationThreshold: 10000,
  },
  tokenCounter,
  logger,
);

const pendingToolCalls = new Map<string, { name: string; args: unknown }>();

for (const msg of messages) {
  for (const part of msg.content) {
    if (part instanceof LanguageModelToolCallPart) {
      pendingToolCalls.set(part.callId, {
        name: part.name,
        args: part.input,
      });
    } else if (part instanceof LanguageModelToolResultPart) {
      const call = pendingToolCalls.get(part.callId);
      if (call) {
        const result = extractToolResultContent(part);
        toolHistory.addToolCall(
          part.callId,
          call.name,
          call.args as Record<string, unknown>,
          result,
          false,
        );
        pendingToolCalls.delete(part.callId);
      }
    }
  }
}

// Step 2: Choose strategy based on capability
const strategy = gatewaySupportsNativeToolHistory()
  ? new NativeStrategy()
  : new TextEmbedStrategy();

// Step 3: Get rendered items
const toolHistoryItems = toolHistory.renderAsItems(strategy);

// Step 4: In translation loop, skip inline tool handling
// and inject toolHistoryItems at the appropriate position
```

**Translation loop modification:**

```typescript
// In translateMessage, replace inline tool handling:

} else if (part instanceof LanguageModelToolCallPart) {
  // NOW HANDLED BY ToolHistoryManager
  // Skip entirely - will be rendered via strategy

} else if (part instanceof LanguageModelToolResultPart) {
  // NOW HANDLED BY ToolHistoryManager
  // Skip entirely - will be rendered via strategy
}
```

### Phase 4: Capability Detection

```typescript
// src/provider/capabilities.ts

/**
 * Check if the Gateway supports native function_call input items.
 *
 * Initially returns false. When Gateway deployment is confirmed,
 * update this to return true (or check version/feature flag).
 */
export function gatewaySupportsNativeToolHistory(): boolean {
  // TODO: Update when Gateway support is confirmed
  // See RFC 00024 for tracking
  return false;
}
```

## Implementation Plan

| Phase                     | Scope                        | Risk   | Effort  |
| ------------------------- | ---------------------------- | ------ | ------- |
| **1: Strategy interface** | New file, no integration     | None   | 1 hour  |
| **2: Enhance manager**    | Add method to existing class | Low    | 30 min  |
| **3: Wire into chat**     | Modify translation flow      | Medium | 2 hours |
| **4: Enable native**      | Flip boolean                 | None   | 5 min   |

**Recommended approach**: Implement phases 1-3 now, phase 4 when Gateway confirms support.

## Acceptance Criteria

### Behavior Preservation

- [ ] All existing tests pass with no modification
- [ ] Tool results still appear in requests as user messages (text-embed)
- [ ] Tool calls still omitted from requests (no mimicry risk)

### Architecture Goals

- [ ] `ToolHistoryManager` is single source of truth for tool history
- [ ] Config values (`maxToolHistoryLength`) actually take effect
- [ ] Truncation/summarization works when history exceeds threshold
- [ ] Dead code in `tool-history.ts` is now live

### Future-Proofing

- [ ] `NativeStrategy` is implemented and tested (but disabled)
- [ ] Capability check exists at single location
- [ ] Flipping to native requires changing one boolean

## Risks and Mitigations

| Risk                                   | Likelihood | Impact | Mitigation                                       |
| -------------------------------------- | ---------- | ------ | ------------------------------------------------ |
| Breaking existing behavior             | Medium     | High   | Comprehensive test coverage, phased rollout      |
| Tool pair extraction misses edge cases | Low        | Medium | Log mismatches, fallback to text                 |
| Performance regression                 | Low        | Low    | Tool history extraction is O(n) on message count |

## Alternatives Considered

### Alternative A: Keep Separate (Status Quo)

**Rejected because:**

- Already has dead code
- Will continue to drift
- Config values are ignored

### Alternative B: Inline Everything (Remove ToolHistoryManager)

**Rejected because:**

- Loses truncation/summarization capability
- No path to native support
- More code duplication

### Alternative C: Wait for Native Support

**Rejected because:**

- Keeps dead code longer
- Risks further drift
- Blocks config from working

## References

- RFC 00024: Native Tool History Migration (Gateway support tracking)
- RFC 013: Tool Call Truncation (original design)
- `packages/openresponses-client/IMPLEMENTATION_CONSTRAINTS.md`
