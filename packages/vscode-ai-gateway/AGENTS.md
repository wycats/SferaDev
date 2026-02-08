# Agent Instructions for vscode-ai-gateway

This VS Code extension provides AI models via the Vercel AI Gateway using the OpenResponses wire protocol.

---

## 🔬 FORENSIC CAPTURE: Live Debugging Workflow

**Forensic Capture** records full request/response data to `.logs/` for debugging conversation state, token tracking, and subagent detection issues.

### Enabling Forensic Capture

1. Open VS Code Settings (`Ctrl+,`)
2. Search for `vercel.ai.forensicCaptureEnabled`
3. Set to `true`

Or add to `settings.json`:

```json
{
  "vercel.ai.forensicCaptureEnabled": true
}
```

### Where Logs Go

Logs are written to the workspace's `.logs/` directory:

```
.logs/
├── forensic-capture-2026-02-07T16-30-00.000Z.json
├── forensic-capture-2026-02-07T16-31-15.000Z.json
└── tree-snapshot-2026-02-07T16-30-00.000Z.json
```

### Analyzing Captures

**Option 1: Narrative Tool** (correlates our logs with VS Code internals)

```bash
node scripts/analyze-agent-logs.ts /path/to/workspace --narrative
```

**Option 2: Raw JSON** (for specific request/response debugging)

```bash
cat .logs/forensic-capture-*.json | jq .
```

**Option 3: VS Code Output Panel**

- Open Output panel (`Ctrl+Shift+U`)
- Select **"Vercel AI"** from dropdown
- Watch `[ConversationStateDebug]`, `[StatusBar]`, `[HybridEstimator]` in real-time

### What Each Capture Contains

| Field              | Purpose                                       |
| ------------------ | --------------------------------------------- |
| `messages`         | Full conversation history sent to API         |
| `model`            | Model ID used for the request                 |
| `usage`            | Actual token counts from API response         |
| `sequenceEstimate` | Token estimate from ConversationStateTracker  |
| `conversationHash` | Unique identifier for this conversation state |
| `agentTypeHash`    | Fingerprint of system prompt + model          |

### Debugging Checklist

1. **Enable forensic capture** before reproducing the issue
2. **Reproduce the issue** (subagent spawn, token jump, etc.)
3. **Check `.logs/`** for the relevant capture files
4. **Run narrative tool** for correlated timeline
5. **Share relevant JSON** if asking for help

---

## ⚠️ CRITICAL: System Prompt Extraction

**DO NOT REMOVE `extractSystemPrompt()` from openresponses-chat.ts!**

VS Code Copilot uses the **proposed System role** (role=3) to send system prompts.
See: `vscode.proposed.languageModelSystem.d.ts`

Without this extraction:

- The system prompt gets translated as a regular message
- Claude sees incorrect conversation structure
- Tool calling breaks

The function also handles **legacy fallback** for older VS Code versions that
may send system prompts as Assistant messages (role=2).

## ⚠️ CRITICAL: API Format Disambiguation

### The OpenResponses API is NOT:

1. **OpenAI Chat Completions API** (`/v1/chat/completions`)
   - Different endpoint (`/v1/responses`)
   - Different request/response schema
   - Different content type discriminators

2. **Vercel AI SDK format**
   - The SDK is a _client library_ that abstracts over APIs
   - OpenResponses is the _wire protocol_ sent over HTTP
   - SDK examples show client-side code, not raw API format

3. **"OpenAI-compatible" APIs**
   - OpenResponses has its own distinct schema
   - Just because it has similar concepts doesn't mean the format is the same

### When debugging or modifying this extension:

- **DO** refer to the [OpenResponses specification](../../packages/openresponses-client/docs/OPENRESPONSES-SPEC.md)
- **DO** use the [OpenAPI schema](../../packages/openresponses-client/openapi.json) as source of truth
- **DO** use types from `openresponses-client` package
- **DO NOT** look at OpenAI documentation for format details
- **DO NOT** look at Vercel AI SDK documentation for wire protocol

## Key Files

| File                                   | Purpose                                    |
| -------------------------------------- | ------------------------------------------ |
| `src/provider/openresponses-chat.ts`   | OpenResponses API integration              |
| `src/provider/stream-adapter.ts`       | Converts streaming events to VS Code parts |
| `src/provider/usage-tracker.ts`        | Tracks token usage                         |
| `../../packages/openresponses-client/` | Generated types and client                 |

## OpenResponses Message Format

### Content Type Rules

| VS Code Role  | OpenResponses Role | Content Type  |
| ------------- | ------------------ | ------------- |
| User (1)      | `user`             | `input_text`  |
| Assistant (2) | `assistant`        | `output_text` |
| Unknown       | `user`             | `input_text`  |

**Mixing up `input_text` vs `output_text` causes HTTP 400 errors!**

### Message Structure

```typescript
// User message
{
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "Hello" }]
}

// Assistant message
{
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: "Hi there!" }]
}
```

### Tool Format (FLAT structure)

```typescript
// CORRECT for OpenResponses
{
  type: "function",
  name: "get_weather",
  description: "Get weather",
  parameters: { type: "object", properties: {...} }
}

// WRONG (OpenAI Chat Completions format - nested)
{
  type: "function",
  function: {  // <-- NO! Don't nest under "function"
    name: "get_weather",
    ...
  }
}
```

## Debugging HTTP 400 Errors

1. Enable trace logging: Set `vercelAiGateway.logging.level` to `"trace"`
2. Check the Output panel for "Vercel AI Gateway" logs
3. Look for the full request body in trace logs
4. Verify:
   - All items have correct `type` discriminator
   - User content uses `input_text`, Assistant uses `output_text`
   - Tools use flat structure (not nested)
   - Required fields are present

## Documentation Links

### Internal

- [OpenResponses Spec Summary](../../packages/openresponses-client/docs/OPENRESPONSES-SPEC.md)
- [OpenAPI Schema](../../packages/openresponses-client/openapi.json)
- [Client Package](../../packages/openresponses-client/README.md)

### External

- **OpenResponses Website**: https://www.openresponses.org
- **OpenResponses Reference**: https://www.openresponses.org/reference
- **OpenResponses Specification**: https://www.openresponses.org/specification
- **OpenAPI JSON**: https://www.openresponses.org/openapi/openapi.json

### NOT Relevant (Do Not Use)

- ❌ OpenAI Chat Completions documentation
- ❌ OpenAI Responses API documentation (it's similar but not identical)
- ❌ Vercel AI SDK `streamText`/`generateText` examples (that's SDK format, not wire format)

---

## Agent Token UI

### User-Facing Goals

The Agent Token UI provides **glanceable status** for users working with AI agents:

| Question                          | UI Element         | How It's Shown                     |
| --------------------------------- | ------------------ | ---------------------------------- |
| "How full is my context?"         | Percentage + color | `71.4k (56%)`, green/orange/red    |
| "Which agent is active?"          | Spinner icon       | `loading~spin` on streaming agents |
| "Are subagents nested correctly?" | Tree hierarchy     | Children indented under parent     |
| "Is something wrong?"             | Error icon         | Red error indicator                |

**The user never needs to see**: conversation hashes, claims, VS Code internals, or raw logs.

### Developer Diagnostics

When the UI is wrong, we have rich diagnostic data. **Use it before asking the user for screenshots.**

#### The Narrative Tool

```bash
node scripts/analyze-agent-logs.ts /path/to/workspace --narrative
```

This outputs a **unified timeline** that correlates:

- Our extension's tree snapshots (agent state, claims, invariants)
- VS Code's internal request logs (model calls, tool invocations)

#### What the Narrative Shows

```
16:10:08.691 [CLAIM_CREATED] anthropic/claude-opus-4.5 (main) expecting "review"
16:10:08.763 [AGENT_COMPLETED] anthropic/claude-opus-4.5 (main)
             └─ VS Code: ccreq:246e2ddf | 8334ms | [panel/editAgent-external]

--- Final Tree State ---
├─ [main] (1036918f) ✓ 69.1k [3]
└─ [sub] (6760da7c) ✓ 71.4k [1]    ← BUG: should be child of main!
```

#### Proactive Debugging Checklist

Before asking the user, check:

1. **Run the narrative**: `node scripts/analyze-agent-logs.ts . --narrative`
2. **Check Final Tree State**: Are agents at the correct hierarchy level?
3. **Check for orphan subagents**: `parentConversationHash: null` on non-main agents = bug
4. **Check claims**: Was a CLAIM_CREATED event logged before the subagent started?
5. **Check invariant violations**: Look for `⚠️ N violation(s)` in the timeline

#### Common Issues & Where to Look

| Symptom                | Check                                     | Likely Cause                     |
| ---------------------- | ----------------------------------------- | -------------------------------- |
| Subagent at root level | `parentConversationHash` in tree snapshot | Claim not created or not matched |
| Wrong percentage       | `maxInputTokens` in tree snapshot         | Model info not enriched          |
| Agent stuck streaming  | `status` field in tree snapshot           | Completion event not received    |
| Duplicate agents       | Agent IDs in tree snapshot                | Identity matching failure        |

#### Key Data in Tree Snapshots

Each log entry contains a full tree snapshot with:

- `agents[]`: All tracked agents with their state
  - `id`, `name`, `status`, `isMain`
  - `inputTokens`, `outputTokens`, `totalInputTokens`, `totalOutputTokens`
  - `conversationHash`, `agentTypeHash`, `parentConversationHash`
  - `maxInputTokens` (for percentage calculation)
- `claims[]`: Pending child claims awaiting match
- `treeText`: Human-readable tree visualization
- `invariants`: Automated consistency checks

#### Adding Diagnostic Logging

When debugging a new issue:

1. Add logging to `treeDiagnostics.log()` calls in `status-bar.ts`
2. Include relevant data in the `data` parameter
3. The narrative tool will automatically include it in the timeline

## ⚠️ CRITICAL: Token Counting vs. State Persistence

**Symptoms**: Status bar shows massive "jumps" (e.g., 20k to 40k) or consistently underestimates by >40%.

**Likely Cause**: **State Amnesia**, NOT "Bad Math".

### The Trap

Agents often assume `TokenCounter` logic is imprecise and try to "tune" the estimator (e.g., changing overhead constants).
**THIS IS ALMOST ALWAYS WRONG FOR LARGE ERRORS.**

### The Reality

Token estimation is mathematically bounded. It is rare for a tokenizer to be off by >20% on English text.
If you see a 50% discrepancy or a 20k jump, it means the extension **forgot the previous conversation state** and is re-estimating the entire context from scratch (incorrectly) instead of using the "Ground Truth" returned by the API.

**Investigation Checklist**:

1. Check `ConversationStateTracker` logic. Are keys unique?
2. Are keys persisting across requests?
3. Is `recordActual` being called?
4. **DO NOT** tune `src/tokens/counter.ts` constants until you verify state persistence.
