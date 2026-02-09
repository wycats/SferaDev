# Investigation: System Prompt Drift causing Context Loss

## Incident Analysis

Test Message 4 (TM4) and Test Message 5 (TM5) failed to maintain conversation continuity (Token State Drift).
Initial hypothesis was "Data Drift" (User content changing).

## Verification Steps

1. **Extracted Captures**: Isolated TM4 and TM5 from `forensic-captures.jsonl`.
2. **User Content Diff**: Compared `messages[1]` (First User Message).
   - result: **Identical**. (No Data Drift).
3. **Internal Drift Diff**: Compared `messages[0]` (System Prompt).
   - result: **Diverged**.
   - TM4 Hash: `ace14...` (Old Prompt, missing `<agents>` block).
   - TM5 Hash: `9af7...` (New Prompt, has `<agents>` block).

## Root Cause

The `ConversationStateTracker` enforces **Strict Inclusion**: all messages in the known state must exist in variables in the current message.

- TM4 State contains `ace14` (System).
- TM5 Input contains `9af7` (System).
- `ace14` is missing from TM5.
- State rejected.
- `recordActual` failed to find a strict prefix (due to Index 0 mismatch).
- **Outcome**: New Conversation ID generated, history link broken.

## Proposed Fix

Enable **Relaxed Prefix Matching** in `recordActual`.

- Use existing (but unused) `findIdentityFromRelaxedPrefix` method.
- Allow Index 0 (System Prompt) mutation to preserve Conservation ID.
