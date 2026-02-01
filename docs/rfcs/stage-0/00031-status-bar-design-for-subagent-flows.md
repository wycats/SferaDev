---
title: Status Bar Design for Subagent Flows
stage: 0
feature: Unknown
exo:
    tool: exo rfc create
    protocol: 1
---

# RFC 00031: Status Bar Design for Subagent Flows

**Status**: Draft  
**Created**: 2026-01-31

## Problem Statement

The current status bar implementation tracks individual LM calls as "agents" but doesn't properly handle subagent flows. When VS Code Copilot runs subagents (like `recon`, `execute`, `review`), each makes separate LM calls, but:

1. We can't distinguish "main conversation" from "subagent" calls
2. We don't know the subagent's name/purpose
3. We lose visibility into the main conversation when a subagent is active
4. There's no session-level view of total token usage

## Research Findings

### API Investigation (2026-01-31)

**Stable API** (`ProvideLanguageModelChatResponseOptions`):

- `modelOptions` - opaque, caller-defined (potential metadata carrier)
- `tools` - available tools
- `toolMode` - tool selection mode
- **No caller identification in stable API**

**Proposed API** (`vscode.proposed.chatProvider.d.ts`):

```typescript
export interface ProvideLanguageModelChatResponseOptions {
  /**
   * What extension initiated the request to the language model
   */
  readonly requestInitiator: string; // Extension identifier!
}
```

**Key Finding**: VS Code's proposed `chatProvider` API adds `requestInitiator` which is the extension identifier (e.g., `github.copilot-chat`). This helps distinguish Copilot from other extensions, but **does NOT identify subagents within Copilot**.

**System Role** (`vscode.proposed.languageModelSystem.d.ts`):

- `LanguageModelChatMessageRole.System = 3` (proposed)
- We already handle this in `system-prompt.ts`
- System prompts often contain agent identity patterns

### What We Can Detect

1. **Extension Caller** (proposed API): `requestInitiator` tells us which extension made the call
2. **System Prompt Content**: Contains agent instructions, often with identity patterns
3. **Message Count**: Subagents typically have shorter conversations (1-3 messages)
4. **System Prompt Hash**: Different hash = different agent type

### What We Cannot Detect

1. **Subagent Name**: No API exposes "recon", "execute", etc.
2. **Conversation ID**: No way to correlate multiple calls to one chat thread
3. **Session Boundaries**: No explicit session start/end signals

## Proposed Design

### Core Insight: System Prompt Fingerprinting

Since subagents have different system prompts than the main conversation, we can:

1. Hash the system prompt to create a "fingerprint"
2. Track the first fingerprint as "main"
3. Different fingerprints = subagents

### Data Model

```typescript
interface AgentFingerprint {
  hash: string; // SHA-256 of system prompt
  shortName: string; // Extracted or generated name
  isMain: boolean; // First seen = main
  firstSeen: number; // Timestamp
}

interface SessionState {
  id: string;
  startTime: number;
  mainFingerprint: string | null;
  fingerprints: Map<string, AgentFingerprint>;

  // Cumulative totals
  totalInputTokens: number;
  totalOutputTokens: number;
  callCount: number;

  // Per-fingerprint totals
  tokensByAgent: Map<string, { input: number; output: number; calls: number }>;
}
```

### Agent Name Extraction

```typescript
function extractAgentName(systemPrompt: string): string {
  // 1. Look for <description>...</description> tags (common in agent prompts)
  const descMatch = systemPrompt.match(/<description>(.*?)<\/description>/is);
  if (descMatch) {
    // Extract first verb or key phrase
    const desc = descMatch[1].trim();
    const verbMatch = desc.match(
      /^(Executes|Gathers|Reviews|Explores|Audits)\b/i,
    );
    if (verbMatch) return verbMatch[1].toLowerCase();
  }

  // 2. Look for "This agent..." pattern
  const agentMatch = systemPrompt.match(/This agent\s+(\w+)/i);
  if (agentMatch) return agentMatch[1].toLowerCase();

  // 3. Look for known agent names in prompt
  const knownAgents = ["recon", "execute", "review", "prepare", "plan"];
  for (const name of knownAgents) {
    if (
      systemPrompt.toLowerCase().includes(`agent is ${name}`) ||
      systemPrompt.toLowerCase().includes(`<name>${name}</name>`)
    ) {
      return name;
    }
  }

  // 4. Fallback: use message count heuristic
  return "sub"; // Generic subagent
}
```

### Status Bar Display

**Main conversation only:**

```
$(check) 52.0k/128.0k
```

**Main + active subagent:**

```
$(loading~spin) 52.0k/128.0k | ▸ recon ~8.0k
```

**Session total (in tooltip or on click):**

```
Session: 85.2k total (3 calls)
├─ Main: 52.0k (1 call)
├─ recon: 8.5k (1 call)
└─ execute: 24.7k (1 call)
```

### Session Boundaries

A new session starts when:

1. **Time gap**: >5 minutes since last call
2. **Main agent reset**: `clearAgents()` called
3. **VS Code restart**: Session state is not persisted

### Implementation Phases

**Phase 1: Session Totals** (Simple, high value)

- Track cumulative tokens across all calls
- Show in tooltip: "Session: 85.2k total (3 calls)"
- No agent identification yet

**Phase 2: System Prompt Fingerprinting**

- Hash system prompts to detect agent changes
- Track main vs subagent distinction
- Show: `52.0k/128.0k | ▸ sub ~8.0k`

**Phase 3: Agent Name Extraction**

- Parse system prompts for agent identity
- Show: `52.0k/128.0k | ▸ recon ~8.0k`

**Phase 4: Proposed API Integration** (Future)

- Enable `chatProvider` proposed API
- Use `requestInitiator` for extension-level tracking
- Better multi-extension support

## Current Behavior

```
Main agent starts:     $(loading~spin) ~52.0k/128.0k (40%)
Main agent completes:  $(check) 52.0k/128.0k
Subagent starts:       $(loading~spin) 52.0k/128.0k | ▸ claude-sonnet-4 ~8.0k/128.0k (6%)
Subagent completes:    $(check) 52.0k/128.0k | claude-sonnet-4: 8.5k/128.0k
```

**Issues:**

- "claude-sonnet-4" is the model ID, not the subagent name
- No way to know this is a "recon" or "execute" subagent
- No session total tracking

## Questions for Discussion

1. **Session totals in main display vs tooltip?**
   - Main: `52.0k/128.0k | Total: 85.2k`
   - Or just in tooltip?

2. **How to show multiple completed subagents?**
   - Stack them: `52.0k | +8.5k | +24.7k`
   - Or just show total: `52.0k | +33.2k sub`

3. **Should we persist session state?**
   - Across VS Code restarts?
   - Or fresh start each time?
