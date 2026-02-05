# Operational Constraints: Agent Identity & Token Tracking

> **Status**: Living document — constraints are hypotheses until empirically verified
> **Last Updated**: 2026-02-04

## 0. User's Original Requirements (Verbatim)

These are the actual constraints and questions to explore, captured exactly as stated:

**Goals:**

- We want to be able to count the number of tokens in each chat window and each agent in the chat window
- We want to be able to identify summarization, so we can treat post-summarization chats as either a separate agent or at least a different context
- Ideally we would be able to link child agents to their parent reliably, and this might involve summarization

**Environmental Facts:**

- The user can switch models to us mid-chat, so we can't rely on being the first model provider in a conversation
- The tool list can change mid-chat, so it's not a reliable source for fingerprinting
- System prompts can be the same across chats and agents, so it's not a reliable source for agent fingerprinting
- We're a language model not a chat participant
- We could implement other parts of the VS Code API, but we want our language model to work seamlessly with the default Copilot participant

**Potential Resources:**

- While we can't use proposed APIs, there _may_ be information in the stable API (or practical stable implementation) that we _could_ rely on. It would require a discussion but we should be proactively looking
- We could potentially use OpenResponses features, but not all features are consistently implemented. We can verify the code in `.reference/ai-gateway`, and since I work at Vercel, we could request features that would be useful

**The Fundamental Constraint:**

- Fundamentally, though, a core part of the loop involves us giving messages back from the language model API, and receiving a new message list from VS Code with updates. **Anything we want to persist across a conversation to give us a stable identity needs to survive that handoff.**

**Meta-Constraint:**

- Previous explorations we did with documented conclusions _might be wrong_. We should revisit all previous constraints from first principles now to make sure they're right. This is hard for you to remember, so we may want to quarantine files that describe previous assumptions with a README that says that they're not validated.

---

## 1. Goals (Derived)

What we want to achieve:

| ID  | Goal                                             | Priority |
| --- | ------------------------------------------------ | -------- |
| G1  | Count tokens per chat window                     | High     |
| G2  | Count tokens per agent in chat window            | High     |
| G3  | Detect summarization events                      | Medium   |
| G4  | Treat post-summarization as new context          | Medium   |
| G5  | Link child agents to parents                     | Medium   |
| G6  | Work seamlessly with default Copilot participant | High     |

## 2. Environmental Facts

The world we operate in (stated constraints):

| ID  | Fact                                                                                                  | Source      |
| --- | ----------------------------------------------------------------------------------------------------- | ----------- |
| E1  | We are a Language Model Provider, not a Chat Participant                                              | User stated |
| E2  | User can switch to us mid-conversation                                                                | User stated |
| E3  | Tool list changes mid-chat — not a stable fingerprint                                                 | User stated |
| E4  | System prompts repeat across chats/agents — not a stable fingerprint                                  | User stated |
| E5  | We want to work seamlessly with default Copilot participant                                           | User stated |
| E6  | We receive messages, return stream, receive updated messages — the handoff is our persistence surface | User stated |
| E7  | We could implement other VS Code APIs, but prefer not to break Copilot integration                    | User stated |
| E8  | We could potentially use OpenResponses features (user works at Vercel)                                | User stated |

## 3. Resources

What we might have access to (needs verification):

| ID  | Resource                             | Notes                                        |
| --- | ------------------------------------ | -------------------------------------------- |
| R1  | Message content (text)               | Survives but visible; needs invisible format |
| R2  | Message role (user/assistant)        | Standard API                                 |
| R3  | Message name field                   | Read-only for us; only User msgs have it     |
| R4  | Memento (workspaceState/globalState) | Side-channel storage, needs correlation key  |
| R5  | OpenResponses response_id            | From server                                  |
| R6  | OpenResponses usage metadata         | Authoritative token counts                   |
| R7  | OpenResponses custom features        | Requestable (user works at Vercel)           |
| R8  | Conversation summary tag             | Detects summarization state (Q4)             |

## 4. The Core Loop

```
┌─────────────────────────────────────────────────────────────┐
│                      VS CODE / COPILOT                       │
│                                                              │
│  1. User sends message                                       │
│  2. Copilot builds message list (may summarize)             │
│  3. Calls our provideLanguageModelChatResponse()            │
│                          ↓                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              OUR EXTENSION (LM Provider)              │   │
│  │                                                       │
│  │  INPUT: messages[], options, progress, token         │   │
│  │  OUTPUT: void (stream via progress.report())         │   │
│  │                                                       │
│  │  ❌ No return value                                   │   │
│  │  ❌ No metadata channel                               │   │
│  │  ✅ Can modify streamed content                       │   │
│  │  ✅ Can use side-channel storage (Memento)           │   │
│  └──────────────────────────────────────────────────────┘   │
│                          ↓                                   │
│  4. Our stream → Copilot → VS Code UI                       │
│  5. VS Code SANITIZES content                               │
│  6. Next turn: we receive sanitized history                 │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**The Fundamental Question:** What can we inject into the stream that:

- Survives VS Code sanitization
- Is recoverable on the next turn
- Doesn't pollute the user experience
- Works even if we weren't the first provider

## 5. Open Questions

Research needed:

| ID  | Question                                            | Why It Matters              | Status                                              |
| --- | --------------------------------------------------- | --------------------------- | --------------------------------------------------- |
| Q1a | What content persists in API messages?              | Determines injection format | ✅ HTML comment syntax persists                     |
| Q1b | What content is invisible to users?                 | UX requirement              | ❌ HTML comments render as visible text             |
| Q2  | Does LanguageModelChatMessage.name persist?         | Could be identity channel   | ✅ Exists but we can't set it (Copilot creates msg) |
| Q3  | Are there undocumented properties on messages?      | Hidden persistence surface  | ✅ Only 3 keys: c, role, name                       |
| Q4  | Can we detect summarization from message patterns?  | Enables G3, G4              | ✅ Yes — `<conversation-summary>` tag in User msg   |
| Q5  | What does Copilot actually send us?                 | Full picture of input       | ✅ Analyzed — see Q5 Findings                       |
| Q6  | Can OpenResponses add a persistence-friendly field? | Server-side solution        | ⚡ Requestable                                      |
| Q7  | Is content-hash + Memento reliable?                 | Side-channel correlation    | ❓ Needs design                                     |

### Q1 Findings (2026-02-04)

- **Q1a (Persistence)**: HTML comment syntax `<!-- ... -->` DOES persist in API messages across turns
  - Evidence: 46 matches for `v.cid` in forensic capture, same conversation ID across all
- **Q1b (Invisibility)**: HTML comments are NOT invisible — they render as literal text in VS Code chat UI
  - Evidence: Screenshots showing `<!-- v.cid:conv_6feb6a21b4 aid:agent_xxx -->` visible to user
  - Root cause: VS Code's markdown renderer doesn't support HTML comments

### Q2/Q3 Findings (2026-02-04)

- `name` field exists on messages but LM Providers can't set it (Copilot creates assistant messages from our stream)
- Only 3 keys on message objects: `c` (content), `role` (1=User, 2=Assistant, 3=System), `name`
- No undocumented properties found
- User messages sometimes have `name: ""` (empty string) — 126 of 146 in sample

### Q4 Findings (2026-02-04) — Summarization Detection

**Summarization mechanism discovered:**

- Copilot uses `<conversation-summary>` tag inside a User message
- Structure: `<conversation-summary><analysis>...</analysis><summary>...</summary></conversation-summary>`
- Contains: chronological review, intent mapping, technical inventory, progress assessment
- Position: Early in message list (index 2 in observed capture)

**Detection strategy:**

- Check User messages for `<conversation-summary>` tag
- Presence = summarization has occurred
- Message count dropping (e.g., 289 → 186) indicates new conversation/panel

**Limitation**: We cannot detect _when_ summarization happened mid-conversation — we only see current state.

### Q5 Findings (2026-02-04) — What Copilot Sends

**Message structure (from forensic capture of 289 messages):**

| Role      | Count | Content Types                   | Notes                         |
| --------- | ----- | ------------------------------- | ----------------------------- |
| System    | 1     | text                            | Contains full system prompt   |
| User      | 146   | text, data, unknown, toolResult | Includes context, attachments |
| Assistant | 142   | text, toolCall                  | Our streamed responses        |

**Content part types observed:**

- `text`: Plain text content
- `data`: Binary data with mimeType (images, etc.)
- `toolCall`: Tool invocation (name, callId, input)
- `toolResult`: Tool response (name, callId, toolResult)
- `unknown`: Unrecognized structure

**Key observations:**

1. System prompt is always first message
2. User messages include VS Code context (`<environment_info>`, `<workspace_info>`)
3. `name` field only populated on User messages (and empty string when set)
4. Message count increments by 2 per turn (user + assistant)
5. Conversation summary appears early when summarization active

## 6. Quarantined Assumptions

Previous explorations with documented conclusions that might be wrong:

| Assumption                                 | Status          | Finding                                    |
| ------------------------------------------ | --------------- | ------------------------------------------ |
| HTML comments are stripped from messages   | ❌ Wrong        | They persist but render as visible text    |
| HTML comments are invisible to users       | ❌ Wrong        | VS Code markdown doesn't support HTML cmts |
| ChatResult.metadata works for LM Providers | ❌ Wrong        | Only for Chat Participants                 |
| System prompt hash is stable identity      | ⚠️ Questionable | Repeats across agents                      |
| Tool list is stable fingerprint            | ❌ Wrong        | Changes mid-chat                           |
| `name` field can be set by LM Provider     | ❌ Wrong        | Copilot creates assistant msgs from stream |

> **Note**: These came from previous exploration. User explicitly stated "previous explorations we did with documented conclusions _might be wrong_" — treat all prior assumptions as hypotheses.

## 7. What We Need to Learn

**Answered:**

1. ✅ **What survives the handoff?** — Content persists, but HTML comments are visible (unacceptable)
2. ✅ **What does Copilot send us?** — System prompt, user context, tool calls/results, conversation summary
3. ✅ **Can we detect summarization?** — Yes, via `<conversation-summary>` tag

**Still open:** 4. ❓ **Q6: Can OpenResponses help?** — Server-side persistence, no injection needed 5. ❓ **Q7: Is Memento + content-hash viable?** — Side-channel correlation strategy 6. ❓ **What format is BOTH persistent AND invisible?** — The core unsolved problem

---

## Changelog

- 2026-02-04: Added Q4 (summarization detection) and Q5 (Copilot message structure) findings
- 2026-02-04: Refined Q1 into Q1a (persistence) and Q1b (invisibility) — both answered
- 2026-02-04: Updated R3 (name field) with verified status
- 2026-02-04: Initial document created from first-principles analysis
