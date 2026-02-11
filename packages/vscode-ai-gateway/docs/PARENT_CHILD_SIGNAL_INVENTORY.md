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

## Evaluated Join Keys

### ✅ Claim mechanism (designed solution)

The `ClaimRegistry` is the **intended** join mechanism:

1. Parent creates claim with `expectedChildAgentName`
2. Child matches claim by name or type hash
3. Child gets `parentConversationHash` linking to parent

**Verdict**: This is the designed solution, but it's not working because the child never calls `startAgent()`.

## The Real Problem

The signals exist on both sides, but the **child never enters our code path**:

- No `AGENT_STARTED` event for the child in tree-diagnostics
- No claim match ever occurs
- The claim expires unused

## Next Investigation

The core question isn't "what signals exist" but "why doesn't the child hit our code path?"

Trace where `startAgent()` is called from:

- `provider.ts` → `provideLanguageModelResponse()` → `startAgent()`
- Does the subagent use a different provider?
- Does VS Code route subagent requests differently?
