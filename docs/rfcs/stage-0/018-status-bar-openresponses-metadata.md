# RFC 018: Status Bar OpenResponses Metadata Enhancements

3. Should session aggregates reset on window reload or persist?2. How verbose should the tooltip be by default?1. Should latency be shown in the status bar text or just tooltip?## Open Questions- OpenResponses flow: `src/provider/openresponses-chat.ts`- Usage tracking: `src/tokens/usage.ts`- Status bar display: `src/statusbar/token-status-bar.ts`- Stream adapter captures metadata: `src/provider/openresponses-stream-adapter.ts`## Code Locations5. Add config flags for optional display elements4. Update click command to show response details3. Update `buildTooltip()` to display new fields2. Pass metadata from stream adapter through `completeAgent()`1. Extend `TokenUsage` interface with new fields## Implementation Plan**Display**: Tooltip section "Session: 12,345 in / 2,345 out (15 requests)"`TokenUsageTracker` already maintains totals.### 5. Session Aggregates**Display**: In click command details for debugging, e.g., "Response: resp_abc123"Already captured in stream adapter (`responseId`, `finishReason`).### 4. Response ID + Finish Reason**Display**: Tooltip line "Latency: 1.2s" or "Time: 1.2s (45 tok/s)"Use `created_at` from response + completion time to calculate latency.### 3. Request Timing/Latency**Display**: Tooltip line "Provider: anthropic" or "Routed: anthropic/claude-sonnet-4"When model ID is a routing alias, show the actual provider that handled the request.### 2. Provider Routing Information**Display**: Show in tooltip as "Input: 1,234 (500 cached)" or "Output: 567 (200 reasoning)"- `output_token_details.reasoning_tokens`- `input_token_details.cached_tokens`OpenResponses `usage` includes:### 1. Cached/Reasoning Token Breakdown## Proposed Enhancements- Background color warnings at 75%/90%- Context compaction info- Subagent indicator- Optional output tokens (config flag)- Input tokens vs max context (with %)**Current display:**- `src/extension.ts` - Creation/config- `src/tokens/usage.ts` - Usage tracking utility- `src/statusbar/token-status-bar.ts` - Main UI class**Files:**## Current Implementation4. **Provider transparency** - Knowing which provider handled a request3. **Performance monitoring** - Tracking latency across requests2. **Debugging** - Correlating issues with specific response IDs1. **Cost awareness** - Understanding cached vs. new token usageThis information is valuable for:- Session aggregate usage- Response IDs for debugging- Request timing/latency- Provider routing information- Cached/reasoning token breakdownsThe OpenResponses API returns metadata that isn't currently surfaced in the status bar:## MotivationEnhance the token status bar to surface rich metadata from OpenResponses API responses, providing users with better visibility into request performance, provider routing, and token usage details.## Summary> **Created**: 2026-01-29> **Feature**: vscode-ai-gateway> **Stage**: 0 (Draft)
   > **Stage**: 0 (Draft)
   > **Feature**: vscode-ai-gateway
   > **Created**: 2026-01-29

## Summary

Enhance the token status bar to surface rich metadata from OpenResponses API responses, providing users with better visibility into request performance, provider routing, and token usage details.

## Motivation

The OpenResponses API returns metadata that isn't currently surfaced in the status bar:

- Cached/reasoning token breakdowns
- Provider routing information
- Request timing/latency
- Response IDs for debugging
- Session aggregate usage

This information is valuable for:

1. **Cost awareness** - Understanding cached vs. new token usage
2. **Debugging** - Correlating issues with specific response IDs
3. **Performance monitoring** - Tracking latency across requests
4. **Provider transparency** - Knowing which provider handled a request

## Current Implementation

**Files:**

- `src/statusbar/token-status-bar.ts` - Main UI class
- `src/tokens/usage.ts` - Usage tracking utility
- `src/extension.ts` - Creation/config

**Current display:**

- Input tokens vs max context (with %)
- Optional output tokens (config flag)
- Subagent indicator
- Context compaction info
- Background color warnings at 75%/90%

## Proposed Enhancements

### 1. Cached/Reasoning Token Breakdown

OpenResponses `usage` includes:

- `input_token_details.cached_tokens`
- `output_token_details.reasoning_tokens`

**Display**: Show in tooltip as "Input: 1,234 (500 cached)" or "Output: 567 (200 reasoning)"

### 2. Provider Routing Information

When model ID is a routing alias, show the actual provider that handled the request.

**Display**: Tooltip line "Provider: anthropic" or "Routed: anthropic/claude-sonnet-4"

### 3. Request Timing/Latency

Use `created_at` from response + completion time to calculate latency.

**Display**: Tooltip line "Latency: 1.2s" or "Time: 1.2s (45 tok/s)"

### 4. Response ID + Finish Reason

Already captured in stream adapter (`responseId`, `finishReason`).

**Display**: In click command details for debugging, e.g., "Response: resp_abc123"

### 5. Session Aggregates

`TokenUsageTracker` already maintains totals.

**Display**: Tooltip section "Session: 12,345 in / 2,345 out (15 requests)"

## Implementation Plan

1. Extend `TokenUsage` interface with new fields
2. Pass metadata from stream adapter through `completeAgent()`
3. Update `buildTooltip()` to display new fields
4. Update click command to show response details
5. Add config flags for optional display elements

## Code Locations

- Stream adapter captures metadata: `src/provider/openresponses-stream-adapter.ts`
- Status bar display: `src/statusbar/token-status-bar.ts`
- Usage tracking: `src/tokens/usage.ts`
- OpenResponses flow: `src/provider/openresponses-chat.ts`

## Open Questions

1. Should latency be shown in the status bar text or just tooltip?
2. How verbose should the tooltip be by default?
3. Should session aggregates reset on window reload or persist?
