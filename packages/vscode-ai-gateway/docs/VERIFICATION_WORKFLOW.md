# Token Tracking & Algebra Verification Workflow

## The Goal

To verify the **Atomic Message Token Algebra** hypothesis: that our "Set Intersection" logic for conversation state works _exactly_ like a "Prefix Match" in valid conversational patterns.

## Prerequisites

> ⚠️ **Cold Start Warning**: After extension rebuild/reinstall, the in-memory `ConversationStateTracker` is wiped. The **first request** will always show `matchType: "none"` because there's nothing to match against.
>
> **To properly test delta estimation:**
>
> 1. Send Message 1 (will be `matchType: "none"`, `source: "estimated"`)
> 2. Wait for response to complete (state is recorded)
> 3. Send Message 2 — **this** is the real test
> 4. Message 2 should show `matchType: "prefix"` or `"exact"`, `source: "delta"`
>
> **Quick cold-start check:**
>
> ```bash
> tail -n 2 ~/.vscode-ai-gateway/forensic-captures.jsonl | jq -r '[.timestamp, .sequence, .tokens.conversationLookup.matchType, .tokens.breakdown.source] | @tsv'
> ```
>
> If you only see 1 line, you're still in cold start. Send another message.

## The Evidence (Forensic Capture)

We rely on **Forensic Capture Logs** (`forensic-captures.jsonl`) rather than transient terminal output. These logs contain the "Ground Truth" of what the extension actually calculated.

### 1. Locate the Log

The logs are stored in the user's home directory to persist across extension rebuilds.

```bash
# Get the most recent capture (The "Truth")
tail -n 1 ~/.vscode-ai-gateway/forensic-captures.jsonl | jq .
```

### 2. Verify Prefix Matching

Look at the `tokens.conversationLookup` object in the JSON output. This tells you _why_ a match succeeded or failed.

**✅ Success State (Prefix Match):**

```json
"conversationLookup": {
  "hasState": true,
  "matchType": "prefix",      // <--- CRITICAL: Must be "prefix"
  "stateSize": 26             // Number of reusable messages found
}
```

**❌ Failure Analysis (Ambiguous/Drift):**

If `matchType` is `"none"`, you must inspect the `candidates` array to understand _why_.

```bash
# Check candidates vs current hashes
tail -n 1 ~/.vscode-ai-gateway/forensic-captures.jsonl | jq '{
  currentFirst: .tokens.conversationLookup.currentFirstHash,
  candidates: .tokens.conversationLookup.candidates
}'
```

**Common Failure Modes:**

1.  **System Prompt Drift (Index 0 Mismatch)**:
    - `currentFirstHash` (e.g., `deadbeef`) != Candidate's `firstHash` (e.g., `faceb00c`).
    - **Result**: `prefixMatch: 0`. The conversation is considered "new" because the axioms changed.

2.  **"First User Message" Mismatch (Index 1 Mismatch)**:
    - `currentFirstHash` matches candidate.
    - `prefixMatch` is `0` (or `1` if relaxed matching is on).
    - **Diagnosis**: The System Prompt matched, but the _first user message_ (Index 1) is different.

3.  **Forensic Content Verification (The "Show Me" Test)**

    If hashes differ, you must find the _exact_ character difference. Don't guess—diff.

    ```bash
    # 1. Capture the two states (e.g., Turn 4 and Turn 5)
    grep "Test Message 4" ~/.vscode-ai-gateway/forensic-captures.jsonl | tail -n 1 > /tmp/tm4.json
    grep "Test Message 5" ~/.vscode-ai-gateway/forensic-captures.jsonl | tail -n 1 > /tmp/tm5.json

    # 2. Compare the raw content of Index 1 (The First User Message)
    diff <(jq -S .messages[1] /tmp/tm4.json) <(jq -S .messages[1] /tmp/tm5.json)
    ```

    **Common Culprits:**
    - Invisible whitespace changes.
    - Metadata/Part type changes (Text vs Data).
    - Timestamp injections.

    **Checking System Prompt Drift (Index 0):**
    If Index 1 is identical, the drift might be in the System Prompt.

    ```bash
    # Compare System Prompt (Index 0)
    diff <(jq -S .messages[0] /tmp/tm4.json) <(jq -S .messages[0] /tmp/tm5.json)
    ```

    Changes here (e.g., `<agents>` block injection) break strict prefix matching but may be recoverable.

4.  **Identity Loss (Null ID)**:
    - Check if the _previous_ turn generated a conversation ID.
    - `grep "Test Message 4" ... | jq .tokens.estimate` -> `{"conversationId": null}`.
    - If ID is null, the state was not persisted, and subsequent turns will define themselves as "new" or fail to find a parent.

**✅ Success State (Delta Calculation):**

**✅ Success State (Delta Calculation):**

```json
"tokens": {
  "breakdown": {
    "source": "delta",        // <--- CRITICAL: Calculated incrementally
    "knownTokens": 33867,     // Check this against previous "total"
    "messageTokens": 83380    // Total context size
  }
}
```

### 3. Verify State Persistence

Check the `conversationHash`. It should remain stable for a linear conversation history.

```json
"internalState": {
  "chatId": "chat-..."        // VS Code's Chat ID
},
"sequence": 70                // Turn number (incrementing)
```

### 4. Verify Model Identity & Routing

To confirm which model was actually used (vs. requested), check the request parameters in the capture.

```bash
tail -n 1 ~/.vscode-ai-gateway/forensic-captures.jsonl | jq '{model: .request.modelId, messages: .request.messages | length}'
```

**Common "Phantom Model" Scenarios:**

- **Explicit vs. Implicit**: If you see `gpt-5.2-codex` or similar unexpected IDs, it likely indicates a fallback in the `ai-sdk` layer when an external provider fails or times out.
- **Agent Identity**: Verify the agent's self-concept in `tree-diagnostics.log`.
  ```bash
  grep "isMain: true" .logs/tree-diagnostics.log | tail -n 1
  ```
  Look for `name: "openai/gpt-5.2-codex"` coupled with `isMain: true`. This confirms the agent was instantiated with that identity.

## Common Test Patterns

### Level 1: Subagent Handoff (The "Strict Inclusion" Test)

When a subagent starts (new system prompt), the tracker **MUST** reject the prefix match and start a new branch.

**Expected Log Output:**

- `matchType`: "none" (or "exact" if 0 messages match)
- `invariants`: `strictInclusionFailed`

### Level 2: Branching/Backtracking

Edit a message 5 turns back. The tracker **MUST** find the prefix up to that point.

**Expected Log Output:**

- `matchType`: "prefix"
- `stateSize`: (Length of history - 5)

## Debugging "Evaporated" Workflows

If you lose context on _where_ we are in a test plan, run:

```bash
# Find the last "Test Message" sent by the user
grep -r "Test Message" .logs/current.log | tail -n 5
```

Then correlate the timestamp with the forensic capture.

## 🔗 Correlating Subagents (The "Narrative Log")

Forensic captures alone do not link parents to children because VS Code treats them as separate sessions. To see the hierarchy, use the Narrative Tool.

```bash
node scripts/analyze-agent-logs.ts /path/to/workspace --narrative
```

**What to look for:**

1.  **`[CLAIM_CREATED]`**: The parent agent "booking" a slot for a child.
    ```
    12:00:01 [CLAIM_CREATED] anthropic/claude-opus (main) expecting "recon"
    ```
2.  **`[AGENT_STARTED]` (Matched)**: The child agent starting and _claiming_ that slot.
    ```
    12:00:05 [AGENT_STARTED] ... claimMatched: true
    ```
3.  **`[VS Code]` Spans**: The actual request duration and model ID.

**Example Trace:**

```
[CLAIM_CREATED] main -> sub
    ... (time passes) ...
[VS Code] sub-model | [tool/runSubagent]
    └─ ccreq:12345 | 5000ms
```
