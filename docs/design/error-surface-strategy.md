# Error Surface Strategy

**Status**: Living document — for review and discussion
**Last updated**: 2026-02-13

## Overview

This document enumerates every location where the extension surfaces errors to users, describes what the user currently sees, and outlines the strategy for each. The goal is to have a single reference for discussing error UX decisions.

## Error Surfaces

The extension has **four distinct channels** for communicating errors to users:

| Channel          | Where it appears           | Persistence                 | Example                                 |
| ---------------- | -------------------------- | --------------------------- | --------------------------------------- |
| **Inline text**  | Inside the chat response   | Permanent (in conversation) | `**Error:** Rate limit exceeded...`     |
| **Notification** | VS Code notification toast | Dismissable                 | "Your API key was rejected..." + button |
| **Status bar**   | Bottom status bar          | Transient                   | Token limit info                        |
| **Silent**       | Nowhere — logged only      | N/A                         | Model list fetch failure (before fix)   |

## Error Location Inventory

### 1. Model List Fetch (`provider.ts` ~L212-226)

**Trigger**: `getModels()` API call fails (network, auth, server error).

**Current behavior**:

- If cached models exist → silently returns cache (good)
- If no cache → shows warning notification: _"Unable to load models from Vercel AI Gateway. The model picker may be empty until connectivity is restored."_

**Strategy**: This is a background operation. Notification is appropriate because the user didn't directly trigger it — they just opened the model picker and it's empty. No inline error possible here.

**Open question**: Should we retry the model list fetch automatically? Currently we don't.

### 2. No API Key (`provider.ts` ~L408-417)

**Trigger**: User tries to chat but has no API key configured.

**Current behavior**: Notification with "Manage Authentication" button.

**Strategy**: Good as-is. Auth setup is a one-time action, and the button provides a direct path to fix it.

### 3. Chat Request Failure — Auth (401) (`openresponses-chat.ts` ~L940-960)

**Trigger**: API returns 401 during a chat request.

**Current behavior**:

- Notification: _"Your authentication has expired/rejected..."_ + "Manage Authentication" button
- Inline: raw error message (the notification is the primary UX)

**Strategy**: Dual-channel (notification + inline) is appropriate for auth errors because the user needs to take action outside the chat. The notification provides the action button.

**Open question**: Should the inline message also be friendly, or is the notification sufficient?

### 4. Chat Request Failure — HTTP Status (`openresponses-chat.ts` ~L880-930)

**Trigger**: API returns a non-401 HTTP error during chat.

**Current behavior** (after Phase 2 changes):

| Status  | Inline message                                               | Retry?                               |
| ------- | ------------------------------------------------------------ | ------------------------------------ |
| 403     | _"Your API key was rejected by the server..."_               | No                                   |
| 404     | _"Model not found. Check that the model name is correct..."_ | No                                   |
| 429     | _"Rate limit exceeded. Please wait a moment..."_             | Yes (up to 3×, respects Retry-After) |
| 500     | _"The AI Gateway encountered an internal error..."_          | Yes (1× only)                        |
| 502/503 | _"The AI Gateway is temporarily unavailable..."_             | Yes (up to 3×)                       |
| Other   | Raw error message                                            | No                                   |

**Strategy**: Status-specific messages with actionable guidance. Retry happens silently before the user sees anything (only when no stream events have been emitted yet).

**Open questions**:

- Should 429 show a progress indicator during retry wait?
- Should we tell the user "Retrying..." or keep it invisible?

### 5. Chat Request Failure — Network (`openresponses-chat.ts` ~L365-380)

**Trigger**: Fetch/DNS/connection failure (not an HTTP response at all).

**Current behavior**: Inline: _"Unable to reach the AI Gateway. Check your internet connection and try again."_

**Strategy**: Network errors are retried (up to 3×) before the user sees anything. If all retries fail, the friendly message appears.

### 6. Stream: `response.failed` (`stream-adapter.ts` ~L569-605)

**Trigger**: SSE event indicating the response generation failed server-side.

**Current behavior**: Inline: _"The model failed to generate a response. Please try again."_ (raw error preserved in logs)

**Strategy**: Generic friendly message because `response.failed` reasons are opaque server-side errors. The raw error is logged for forensics.

**Open question**: Should we attempt to classify `response.failed` error codes more granularly?

### 7. Stream: `response.incomplete` (`stream-adapter.ts` ~L606-655)

**Trigger**: SSE event indicating the response ended prematurely.

**Current behavior** (after Phase 2 — was previously **completely silent**):

| Reason              | Inline message                                                                 | Style       |
| ------------------- | ------------------------------------------------------------------------------ | ----------- |
| `content_filter`    | _"The response was filtered due to content policy..."_                         | `**Note:**` |
| `max_output_tokens` | _"The response was truncated because it reached the maximum output length..."_ | `**Note:**` |
| Other               | _"Response ended unexpectedly (reason: X)."_                                   | `**Note:**` |

**Strategy**: These are `**Note:**` rather than `**Error:**` because partial content was delivered. The user got _something_ — we're just explaining why it stopped.

**Open question**: For `max_output_tokens`, should we suggest "Try asking the model to be more concise" or similar?

### 8. Stream: `error` event (`stream-adapter.ts` ~L1303-1350)

**Trigger**: SSE error event during streaming.

**Current behavior**:

| Error code                        | Inline message                                      |
| --------------------------------- | --------------------------------------------------- |
| `rate_limit_exceeded`             | _"Rate limit exceeded. Please wait a moment..."_    |
| `server_error` / `internal_error` | _"The AI Gateway encountered an internal error..."_ |
| Other                             | _"An error occurred (CODE). Please try again."_     |

**Strategy**: These are mid-stream errors (content may have already been delivered), so retry is not possible. We classify known codes and fall back to including the code for unknown ones.

### 9. Inactivity Timeout (`openresponses-chat.ts` ~L737-772)

**Trigger**: 120 seconds with no SSE events.

**Current behavior**: Inline: _"Request timed out — the model did not respond within 120 seconds. This may indicate a temporary issue with the AI Gateway."_

**Strategy**: Good as-is. Timeout is a clear failure with a clear message.

### 10. No Response Content (`openresponses-chat.ts` ~L679-726)

**Trigger**: Stream completes normally but produced no text/tool-call content.

**Current behavior**: Inline: _"No response received from model. Please try again."_

**Strategy**: Good as-is. This catches edge cases where the API returns success but empty content.

### 11. Token Limit Exceeded (`provider.ts` ~L475-483)

**Trigger**: Error message contains token count information.

**Current behavior**: Status bar shows token info; inline shows raw error.

**Strategy**: This is handled by VS Code's built-in summarization system. The status bar display is informational. The inline error could be friendlier.

**Open question**: Should we intercept this and show a friendlier inline message like "Your conversation is too long for this model. VS Code will automatically summarize it."?

### 12. Investigation Log Write Failure (`investigation.ts` ~L435-438)

**Trigger**: Writing to the forensic log file fails.

**Current behavior**: Notification: _"Investigation logging failed..."_

**Strategy**: This is an internal diagnostic failure, not a user-facing feature failure. Notification is appropriate but could be demoted to a log-only message since users don't know what "investigation logging" is.

## Retry Strategy

Retry is implemented as a **pre-stream guard**: it only activates when the error occurs before any stream events have been emitted (`eventCount === 0 && !responseSent`). Once the stream has started delivering content, we never retry because:

1. The user is already seeing partial output
2. Retrying would duplicate or lose content
3. Mid-stream errors are surfaced inline instead

### Retry Classification

```
Retryable:
  429 (rate limit)  → up to 3 retries, respects Retry-After header
  502/503 (gateway) → up to 3 retries
  500 (server)      → 1 retry only (ambiguous — could be persistent)
  Network errors    → up to 3 retries (ECONNREFUSED, ENOTFOUND, ETIMEDOUT, etc.)

Not retryable:
  401/403 (auth)    → needs user action
  404 (not found)   → needs user action
  400 (bad request) → needs code fix
  Cancellation      → user intent
  Unknown           → conservative default
```

### Backoff

Exponential with jitter: `delay = min(initial × multiplier^attempt, maxDelay) × (1 ± jitter)`

Defaults: 1s initial, 2× multiplier, 16s max, ±25% jitter.

## ErrorCaptureLogger Coverage

The `ErrorCaptureLogger` writes structured error data to `globalStorageUri/errors/` for forensic analysis. Current coverage:

| Error location           | Capture type    | Captured?               |
| ------------------------ | --------------- | ----------------------- |
| Chat API errors          | `api-error`     | ✅ Yes                  |
| Network errors           | `network-error` | ✅ Yes (new in Phase 2) |
| No response              | `no-response`   | ✅ Yes                  |
| Timeout                  | `timeout`       | ✅ Yes                  |
| Stream `response.failed` | —               | ❌ Not yet              |
| Stream `error` event     | —               | ❌ Not yet              |
| Model list failure       | —               | ❌ Not yet              |

**Open question**: Should we wire ErrorCaptureLogger into the stream-level errors? They're currently logged but not captured to disk.

## VS Code Error Takeover

There is a layer boundary issue: when our `provideLanguageModelChatResponse` throws or returns without emitting any `progress.report()` parts, VS Code's own chat service catches the error and shows its generic error UI ("Sorry, no response was returned" + "try again" button) instead of our classified error messages.

This happens because VS Code's `chatServiceImpl.ts` wraps all provider calls and has its own error rendering via `IChatResponseErrorDetails`. Our friendly error messages (from `classifyError()`) are emitted as inline markdown via `progress.report()`, but if the error occurs before we get a chance to report anything, VS Code's layer handles it.

**Current mitigation**: The retry logic (Phase 2) retries transient failures up to 3x before the error propagates, reducing how often users see VS Code's generic message.

**Potential fix**: In the catch block, before re-throwing, emit a friendly error message via `progress.report()` so VS Code renders our message inline rather than its own. This would require careful handling to avoid double-reporting errors.

## Summary of Open Questions

1. Should model list fetch retry automatically?
2. Should 401 inline message also be friendly (notification is primary)?
3. Should retry show "Retrying..." to the user or stay invisible?
4. Should `response.failed` error codes be classified more granularly?
5. Should `max_output_tokens` suggest the user ask for conciseness?
6. Should token limit exceeded get a friendlier inline message?
7. Should investigation log failures be demoted from notification to log-only?
8. Should stream-level errors be captured to ErrorCaptureLogger disk files?
