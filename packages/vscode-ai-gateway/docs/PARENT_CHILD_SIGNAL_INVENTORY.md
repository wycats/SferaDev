# Parent-Child Signal Inventory

## Goal

Catalog every piece of raw information available on the parent side and child side that could theoretically serve as a join key to link them.

## The Divide

Parent and child agents are treated as **separate sessions** by VS Code. The extension sees them as independent requests. We need to find signals that can correlate them.

## Available Signals

### Parent Side (tree-diagnostics.log)

| Signal                   | Example Value   | Notes                                                       |
| ------------------------ | --------------- | ----------------------------------------------------------- |
| `agentId`                | `28799370`      | VS Code's internal ID (derived from timestamp)              |
| `systemPromptHash`       | `adc6e346`      | 8-char truncated hash of system prompt                      |
| `agentTypeHash`          | `4c7a261f`      | Hash of agent "type" (tools + config)                       |
| `conversationHash`       | `86f382c3`      | Hash of conversation state (only after completion)          |
| `expectedChildAgentName` | `"recon"`       | From CLAIM_CREATED event                                    |
| `parentIdentifier`       | `4c7a261f`      | Used for claim matching (agentTypeHash or conversationHash) |
| `timestamp`              | `05:33:24.625Z` | When claim was created                                      |

### Child Side (forensic-captures.jsonl)

| Signal             | Example Value                 | Notes                               |
| ------------------ | ----------------------------- | ----------------------------------- |
| `chatId`           | `chat-6fd1e1cf-1770528799370` | Our generated ID (hash + timestamp) |
| `systemPromptHash` | `adc6e346de224c45`            | Full 16-char hash                   |
| `model.id`         | `anthropic/claude-opus-4.5`   | Model used                          |
| `messageCount`     | `3`                           | Fresh conversation has few messages |
| `timestamp`        | `05:33:19.386Z`               | When capture was created            |
| `sequence`         | `8`                           | Global sequence number              |

## Evaluated Join Keys

### ❌ chatId suffix = parent agentId

**Initial observation**: Child's `chatId` suffix `1770528799370` contains parent's `agentId` `28799370`.

**Reality**: Both are derived from `Date.now()`. The "embedding" is just that both IDs use timestamps, and the last 8 digits of a 13-digit epoch timestamp will match any other ID generated at the same millisecond.

**Verdict**: Coincidental, not a join key.

### ❌ systemPromptHash prefix match

**Initial observation**: Parent has `adc6e346`, child has `adc6e346de224c45`.

**Reality**: Same hash, different truncation. The tree-diagnostics log calls `.slice(0, 8)` for display. Not a hash property.

**Verdict**: Same hash, but NOT useful as join key because many sessions share the same system prompt (26 sessions had `adc6e346de224c45`).

### ⚠️ systemPromptHash (same value)

Both parent and child have the same system prompt hash because they use the same VS Code agent-mode system prompt (14988 chars).

**Verdict**: Identifies session TYPE, not instance. Not a join key.

### ⚠️ Temporal proximity

Parent `AGENT_STARTED` and child forensic capture are within ~5ms.

**Verdict**: Weak signal. Could help narrow candidates but not definitive.

### ⚠️ messageCount

Child agents start fresh with very few messages (3-5), while resumed main agents have many (50+).

**Verdict**: Distinguishes "new session" from "resumed session", but doesn't link to specific parent.

### ✅ Claim mechanism (designed solution)

The `ClaimRegistry` is the **intended** join mechanism:

1. Parent creates claim with `expectedChildAgentName`
2. Child matches claim by name or type hash
3. Child gets `parentConversationHash` linking to parent

**Verdict**: This is the designed solution, but it's not working because the child never calls `startAgent()`.

## The Real Problem

The signals exist on both sides, but the **child never enters our code path**. The forensic capture proves the child ran, but:

- No `AGENT_STARTED` event for the child in tree-diagnostics
- No claim match ever occurs
- The claim expires unused

## Potential New Signals to Explore

1. **VS Code session ID** - Both logs have `vscodeSessionId`. Are they the same?
2. **Request timing** - Can we correlate by request start/end times?
3. **Model ID** - If child uses a different model, that's a distinguishing signal
4. **Tool schema hash** - The `toolSchemaHashes` in forensic capture might differ

## Next Investigation

The core question isn't "what signals exist" but "why doesn't the child hit our code path?"

Trace where `startAgent()` is called from:

- `provider.ts` → `provideLanguageModelResponse()` → `startAgent()`
- Does the subagent use a different provider?
- Does VS Code route subagent requests differently?
