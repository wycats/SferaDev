---
title: Token Interface — Implementation Map
feature: Unknown
exo:
    tool: exo rfc create
    protocol: 1
---

# RFC 00069: Token Interface — Implementation Map

RFC 00066: Interface-First API Alignment
Goal: design-token-interface, Task: map-implementations

## Interface → Implementation Mapping

### TokenEstimator Implementation: AiTokenizerEstimator (Current Workaround)

| Interface Method | Current Code | Notes |
|---|---|---|
| `estimateInput(messages, modelFamily, options)` | `TokenCounter.estimateMessageTokens()` per message + `countToolsTokens()` + `countSystemPromptTokens()` in `provider.ts:295-305` | Returns `TokenEstimate { total, isAnchored: false, breakdown: [{category: "System", ...}, {category: "Tools", ...}, {category: "Conversation", ...}] }` |
| `name` | `"ai-tokenizer"` | — |

**Files touched:**
- `src/tokens/counter.ts` — TokenCounter class (unchanged, wrapped)
- `src/provider.ts:295-305` — `estimateTotalInputTokens()` method → delegates to `tokenService.estimator.estimateInput()`

**Category mapping:**
| Category | Current Method | Tokens |
|---|---|---|
| "System" | `countSystemPromptTokens(systemPrompt, family)` | text + 28 overhead |
| "Tools" | `countToolsTokens(tools, family)` | 16 base + 8/tool + content × multiplier |
| "Conversation" | Sum of `estimateMessageTokens()` for non-system messages | per-message with overhead |

### TokenUsageReporter Implementation: OpenResponsesUsageReporter (Current Workaround)

| Interface Method | Current Code | Notes |
|---|---|---|
| `report(apiUsage, estimate?)` | `markAgentComplete(usage)` in `openresponses-chat.ts:158-186` | Converts `Usage { input_tokens, output_tokens }` → `TokenUsageReport { promptTokens: usage.input_tokens, completionTokens: usage.output_tokens }` |
| `name` | `"openresponses"` | — |

**Files touched:**
- `src/provider/openresponses-chat.ts:158-186` — `markAgentComplete()` → delegates to `tokenService.reporter.report(usage)`
- `src/status-bar.ts:781` — `completeAgent(agentId, usage: TokenUsage)` → receives `TokenUsageReport`

**Breakdown derivation:** OpenResponses API doesn't provide category breakdown. When `estimate` is provided, the reporter can derive breakdown from the estimate's proportions applied to actual totals:
```
actualCategory = Math.round(actualTotal * (estimateCategory / estimateTotal))
```

### TokenEstimator Implementation: ChatResultUsageEstimator (Future — chatParticipantAdditions)

Not applicable — ChatResultUsage doesn't provide estimation, only actuals.

### TokenUsageReporter Implementation: ChatResultUsageReporter (Future — chatParticipantAdditions)

| Interface Method | Proposal API | Notes |
|---|---|---|
| `report(apiUsage)` | `ChatResponseStream.usage(usage: ChatResultUsage)` | Converts `ChatResultUsage { promptTokens, completionTokens, promptTokenDetails? }` → `TokenUsageReport` |
| `name` | `"chat-result-usage"` | — |

**Breakdown conversion:**
```typescript
// ChatResultPromptTokenDetail uses percentages → convert to absolute counts
const breakdown = usage.promptTokenDetails?.map(detail => ({
  category: detail.category,
  label: detail.label,
  tokens: Math.round(usage.promptTokens * detail.percentageOfPrompt / 100),
}));
```

**Prerequisite:** Extension must register as a `ChatParticipant` to access `ChatResponseStream`. Same architectural requirement as identity interface.

## Consumer Migration Map

| Consumer | Current Usage | Migration |
|---|---|---|
| `provider.ts` | `estimateTotalInputTokens(model, messages, options)` | `tokenService.estimator.estimateInput(messages, modelFamily, options)` |
| `openresponses-chat.ts` | `markAgentComplete(usage?: Usage)` | `tokenService.reporter.report(usage)` → pass to status bar |
| `status-bar.ts` | `completeAgent(agentId, usage: TokenUsage)` | `completeAgent(agentId, report: TokenUsageReport)` — field rename: `inputTokens→promptTokens`, `outputTokens→completionTokens` |
| `agent-tree.ts` | `agent.inputTokens`, `agent.outputTokens` | Same fields, renamed to match TokenUsageReport |
| `display.ts` | `getDisplayTokens(agent)` | Same logic, uses renamed fields |
| `persistence/stores.ts` | `lastActualInputTokens` | `lastActualPromptTokens` (rename for consistency) |

**Key insight:** The main migration cost is field renaming (`inputTokens→promptTokens`, `outputTokens→completionTokens`) to align with ChatResultUsage naming. This is a mechanical change.

## Adoption Strategy

### Phase 1: Extract (No behavior change)
1. Create `TokenCountService` with `AiTokenizerEstimator` + `OpenResponsesUsageReporter`
2. Replace inline estimation in `provider.ts` with service calls
3. Replace inline usage extraction in `openresponses-chat.ts` with reporter
4. Rename fields to match ChatResultUsage naming convention
5. All tests pass unchanged (field renames are internal)

### Phase 2: Add category breakdown
1. Expose category breakdown from `AiTokenizerEstimator`
2. Derive breakdown for actuals using estimate proportions
3. Display breakdown in agent-tree tooltips

### Phase 3: Switch (When chatParticipantAdditions stabilizes)
1. Add `ChatResultUsageReporter` implementation
2. Use native `promptTokenDetails` instead of derived breakdown
3. Keep `AiTokenizerEstimator` for pre-flight estimation (ChatResultUsage doesn't estimate)
