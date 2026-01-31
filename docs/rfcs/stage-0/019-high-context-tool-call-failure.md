# RFC 019: High-Context Tool Call Failure ("Pause" Issue)

## Stage: 0 (Idea)

## Problem Statement

At high context sizes (~130k+ input tokens), Claude Opus 4.5 via Vercel AI Gateway exhibits a failure pattern where the model:

1. Generates text announcing intention to use tools (e.g., "Let me run the execute agent:")
2. Stops with `finish_reason: stop` without actually calling any tools
3. Returns only 20-65 output tokens despite `max_output_tokens: 4096`

This creates a "pause" UX where the model appears to be about to act but doesn't.

## Evidence

### Captured Failure (pause-exo4.txt)

```
Input tokens: 136,565
Output tokens: 65
Tool calls: 0
finish_reason: stop
```

Model output: "The prepare agent provided a detailed readiness report. Let me add the implementation steps and run the execute agent:"

### Replay Results

Same request replayed produces consistent behavior:

- Different text each time but same pattern
- Always announces intent, never follows through
- 0 tool calls despite 75 tools provided

### Reduced Context Test

With only 10 messages (~5k tokens):

- Model outputs more text (95+ chars vs 26)
- Still no tool calls but doesn't abort as abruptly
- Suggests context size is a factor

## Root Causes Identified

### 1. Disguised System Prompt (FIXED)

VS Code Copilot sends the system prompt as an Assistant message (since the Language Model API has no System role). We were passing this through as `role: "assistant"`, causing the model to see itself as having already spoken first with a 22k character "response".

**Fix Applied**: Detect and redirect to `instructions` field.

### 2. Context Size Impact (UNFIXED)

At very high context (130k+ tokens), the model appears to:

- Generate brief summaries instead of taking action
- "Lose focus" on the tool-use intention
- Stop prematurely with minimal output

This may be:

- Model behavior at scale (becomes "lazy")
- Gateway/API limitation
- Prompt structure issue at scale

## Potential Solutions

### A. Context Compression

Reduce input token count by:

- Summarizing older messages
- Compacting tool results
- Removing redundant context

RFC 010 (Smart Context Compaction) addresses this.

### B. Tool Use Prompting

Add stronger prompting at high context:

- "You MUST call a tool in your response"
- Use `tool_choice: required` mode
- Add explicit tool-use reminders in instructions

### C. Request Chunking

Break large requests into smaller chunks:

- Keep only most recent N messages
- Summarize older context
- Use conversation summary technique

### D. Model-Specific Handling

Different models may handle high context differently:

- Claude Sonnet may be more reliable
- Consider model fallback at high token counts
- Document model-specific limits

## Monitoring

The suspicious request saving mechanism successfully captured this pattern:

- Log: `[WARN] SUSPICIOUS: Tools provided but model stopped without calling any`
- File: `/var/home/wycats/.logs/last-suspicious-request.json`

## Next Steps

1. Document this pattern in extension README
2. Consider implementing context compression (RFC 010)
3. Test with `tool_choice: required` to force tool calls
4. Compare behavior across different Claude models
5. File issue with Vercel AI Gateway team if behavior persists

## Related RFCs

- RFC 010: Smart Context Compaction
- RFC 013: Tool Call Truncation
- RFC 009: Token Counting & Context Management
