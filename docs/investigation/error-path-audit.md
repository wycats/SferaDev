# Error Path Audit — VS Code AI Gateway Extension

**Date**: 2026-02-13
**Phase**: Error UX & Resilience (Internal Release Readiness)

## Summary

15 distinct error paths identified across 4 files. Key findings:
- **Well-handled**: Auth failures (401) with actionable buttons, no-response diagnostic, timeout with guidance
- **Poorly handled**: 404/429/5xx show raw error messages with no guidance
- **Silent failures**: `response.incomplete` (truncation/content filter), model list fetch errors
- **Missing capture**: Stream-level errors not logged to ErrorCaptureLogger

## Error Path Inventory

### provider.ts

| # | Line | Trigger | User Sees | Actionability | Captured |
|---|------|---------|-----------|---------------|----------|
| 1 | ~212-225 | `getModels()` throws | **Silent** — logged only | None | No |
| 2 | ~408-417 | No API key configured | Notification: "No API key configured..." + "Manage Authentication" button | Good | No |
| 3 | ~462-498 | Any non-cancel exception during chat | Inline: `**Error:** ${errorMessage}` | Poor | No |
| 4 | ~475-483 | Token limit exceeded (extracted from error) | Status bar: "Token limit exceeded: X tokens (max: Y)" | Poor | No |
| 5 | ~668-677 | `authentication.getSession()` throws | Notification: "Failed to authenticate..." | Good | No |

### openresponses-chat.ts

| # | Line | Trigger | User Sees | Actionability | Captured |
|---|------|---------|-----------|---------------|----------|
| 6 | ~679-726 | Stream completes with no content | Inline: "No response received from model. Please try again." | Good | Yes (`no-response`) |
| 7 | ~737-772 | 120s inactivity timeout | Inline: "Request timed out — the model did not respond within 120 seconds..." | Good | Yes (`timeout`) |
| 8 | ~804-879 | 401 status | Notification: "Your authentication has expired/rejected..." + button | Good | Yes (`api-error`) |
| 9 | ~794-879 | 404 status | Inline: `**Error:** ${errorMessage}` | Poor | Yes (`api-error`) |
| 10 | ~794-879 | 429 status | Inline: `**Error:** ${errorMessage}` | Poor | Yes (`api-error`) |
| 11 | ~794-879 | 5xx status | Inline: `**Error:** ${errorMessage}` | Poor | Yes (`api-error`) |
| 12 | ~794-879 | Network error (ECONNREFUSED etc.) | Inline: `**Error:** ${errorMessage}` | Poor | Yes (`api-error`) |

### stream-adapter.ts

| # | Line | Trigger | User Sees | Actionability | Captured |
|---|------|---------|-----------|---------------|----------|
| 13 | ~568-593 | SSE `response.failed` | Inline: `**Error:** ${errorMessage}` | Poor | No |
| 14 | ~598-635 | SSE `response.incomplete` | **Silent** — no message | None | No |
| 15 | ~1278-1302 | SSE `error` event | Inline: `**Error (${code}):** ${message}` | Poor | No |

### investigation.ts

| # | Line | Trigger | User Sees | Actionability | Captured |
|---|------|---------|-----------|---------------|----------|
| 16 | ~435-438 | Log write failure | Notification: "Investigation logging failed..." | Good | No |

## Gap Analysis

### Critical Gaps

1. **No status-specific UX for 404/429/5xx**: All HTTP errors show raw `errorMessage` with no guidance. Users don't know if they should retry, check their model name, or wait.

2. **`response.incomplete` is silent**: When a response is truncated due to `max_output_tokens` or `content_filter`, the user gets no indication. This is confusing — the response just stops.

3. **Stream errors not captured**: `response.failed` and `error` SSE events bypass ErrorCaptureLogger entirely, losing forensic data.

4. **Model list fetch failures are silent**: If the model list API fails, users see an empty model picker with no explanation.

5. **`network-error` type defined but never used**: ErrorCaptureLogger defines a `network-error` capture type, but all network errors are recorded as `api-error`.

### Moderate Gaps

6. **No malformed SSE handling**: If the SSE parser encounters invalid data, it falls into generic error handling with unclear messaging.

7. **Token limit error is status-bar only**: Token limit exceeded shows in status bar but the inline chat error is the raw message.

## Recommendations for Goal 2 (User-Friendly Errors)

### Status-Specific Messages (constants.ts)

```
404 → "Model not found. Check that the model name is correct and available in your Vercel AI Gateway."
429 → "Rate limit exceeded. Please wait a moment and try again."
500 → "The AI Gateway encountered an internal error. Please try again in a few moments."
502/503 → "The AI Gateway is temporarily unavailable. Please try again shortly."
Network → "Unable to reach the AI Gateway. Check your internet connection and try again."
content_filter → "The response was filtered due to content policy. Try rephrasing your request."
max_output_tokens → "The response was truncated because it reached the maximum length. The model's output may be incomplete."
```

### ErrorCaptureLogger Coverage

Wire ErrorCaptureLogger into:
- stream-adapter.ts `response.failed` events
- stream-adapter.ts `error` events
- Use `network-error` type for ECONNREFUSED/ENOTFOUND/ETIMEDOUT

### Model List Failure

Show a notification when model list fetch fails and no cached models exist.

## Recommendations for Goal 3 (Retry Resilience)

### Retryable Conditions
- Network errors (ECONNREFUSED, ENOTFOUND, ETIMEDOUT)
- HTTP 502, 503
- HTTP 429 (with Retry-After header respect)

### Non-Retryable Conditions
- HTTP 401, 403 (auth — needs user action)
- HTTP 404 (model not found — needs user action)
- HTTP 400 (bad request — needs code fix)
- HTTP 500 (ambiguous — retry once only)

### Backoff Strategy
- Initial delay: 1s
- Multiplier: 2x
- Max retries: 3
- Max delay: 16s
- Jitter: ±25%
