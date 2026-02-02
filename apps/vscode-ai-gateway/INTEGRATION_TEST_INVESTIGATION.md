# Integration Test Investigation

## Goal

Run automated integration tests that can exercise the VS Code Language Model API to discover unique conversation identifiers.

## Environment

- **OS**: Fedora Silverblue (immutable, containerized)
- **Node**: v25.5.0
- **VS Code**: 1.108.2 (system installed at `/usr/share/code/`)
- **Test Framework**: `@vscode/test-electron@2.5.2`

---

## Verified Facts (Immutable)

### F1: Extension builds correctly with esbuild

- Command: `pnpm build`
- Output: `out/extension.js` (5.4MB bundled)
- **Verified**: 2026-02-01

### F2: Test files compile with tsc

- Command: `pnpm exec tsc -p tsconfig.test.json`
- Output: `out/test/runTest.js`, `out/test/suite/index.js`, `out/test/suite/forensic-capture.test.js`
- **Verified**: 2026-02-01

### F3: xvfb-run location on Silverblue

- Path: `/run/host/usr/bin/xvfb-run`
- **Verified**: 2026-02-01

### F4: Downloaded VS Code has native module issues

- Error: `Cannot find module './build/Debug/keymapping'`
- This is a **warning**, not fatal - VS Code continues to run
- **Verified**: 2026-02-01

### F5: Extension path was wrong (FIXED)

- Bug: `extensionDevelopmentPath` resolved to `apps/` instead of `apps/vscode-ai-gateway/`
- Fix: Changed from `path.resolve(__dirname, '../../..')` to `path.resolve(__dirname, '../..')`
- **Verified**: 2026-02-01

### F6: Extension host hangs (user kills it)

- Log shows: `Extension host (LocalProcess pid: XXXXX) is unresponsive.`
- **CRITICAL**: User clarified this is NOT a crash - user manually kills (Ctrl+C) after waiting
- The extension host hangs indefinitely; it does not terminate on its own
- **Implication**: Something blocks forever, we need to find WHERE
- **Verified**: 2026-02-01 (user clarification)

---

## Hypotheses (MECE)

### H1: Test suite entry point fails to load

- **Status**: UNTESTED
- **Test**: Add console.log at top of `suite/index.ts` before any imports
- **Rationale**: If the test suite fails to load (ESM issues, missing deps), extension host may hang waiting

### H2: Extension activation hangs

- **Status**: UNTESTED
- **Test**: Add console.log/timestamps in `activate()` function
- **Rationale**: Something in activate() may be blocking

### H3: Mocha test runner configuration issue

- **Status**: UNTESTED
- **Test**: Simplify test suite to absolute minimum (no imports, single sync test)
- **Rationale**: The glob pattern or Mocha setup may be failing silently

### H4: Extension host communication timeout

- **Status**: UNTESTED
- **Test**: Increase timeout in runTest.ts launchArgs
- **Rationale**: Default timeout may be too short for slow startup

### H5: System VS Code path incorrect

- **Status**: PARTIALLY TESTED
- **Test**: Verify exact path format expected by `@vscode/test-electron`
- **Rationale**: `/usr/share/code/code` may not be the right format

---

## Experiments Log

### Experiment 1: Verify test suite loads

**Date**: 2026-02-01
**Action**: Add diagnostic logging to suite/index.ts
**Expected**: See log output before Mocha runs
**Actual**: (pending)

---

## Dead Ends (Do Not Retry)

1. ~~VS Code Insiders~~ - Same native-keymap issues
2. ~~Running tests while VS Code is open~~ - Fundamental limitation
3. ~~Changing moduleResolution to NodeNext~~ - Requires source changes, reverted

---

## Current Blockers

1. **"Another instance running" error** - VS Code detects user's running instance even with xvfb
2. Previous "unresponsive" behavior was likely this error manifesting differently

## Key Insight (2026-02-01 15:01)

The error message changed! Now we see:

```
Running extension tests from the command line is currently only supported if no other instance of Code is running.
```

This means:

- xvfb provides display isolation but NOT process/IPC isolation
- VS Code uses IPC sockets or lock files to detect other instances
- We need to isolate the user-data-dir and extensions-dir

## Experiment 2: Unique user-data-dir (SUCCESS)

**Date**: 2026-02-01
**Action**: Added `--user-data-dir` with unique timestamp path to launchArgs
**Result**: "Another instance" error FIXED
**New finding**: Test suite loads, `run()` is called, but `mocha.run()` hangs

## Experiment 3: Mocha/ESM Compatibility Investigation

**Date**: 2026-02-01
**Finding**: Mocha loaded via CJS `require()` cannot properly run ESM test files
**Research**: @vscode/test-electron does NOT require Mocha - any programmatic runner works
**Solution**: Replace Mocha with minimal custom test runner

## Current Status (2026-02-01 15:30)

- Replaced Mocha with simple async test runner
- No external test framework dependencies
- Tests defined inline in suite/index.ts
- Ready to rebuild and test

## SUCCESS! (2026-02-01 15:08)

**All 5 tests passed!**

```
=== VS Code Extension Integration Tests ===
  ✓ Extension should be present (0ms)
  ✓ Extension should activate (17ms)
  ✓ vscode.lm API should be available (0ms)
  ✓ selectChatModels should return models (48ms)
  ✓ Forensic: Capture sendRequest metadata (2ms)
=== Results: 5 passed, 0 failed ===
```

**Root Cause**: Mocha/ESM incompatibility. Mocha loaded via CJS `require()` cannot run ESM test files.

**Solution**: Replaced Mocha with a minimal custom test runner (no framework dependencies).

**Captured vscode.lm API surface**:

- selectChatModels, onDidChangeChatModels
- registerLanguageModelChatProvider
- isModelProxyAvailable, onDidChangeModelProxyAvailability, getModelProxy
- registerLanguageModelProxyProvider
- embeddingModels, onDidChangeEmbeddingModels, registerEmbeddingsProvider, computeEmbeddings
- registerTool, invokeTool, tools
- fileIsIgnored, registerIgnoredFileProvider
- registerMcpServerDefinitionProvider, onDidChangeChatRequestTools

**Next Step**: Run tests with authentication to capture sendRequest metadata

## Why No Models? (2026-02-01 15:20)

The test showed 0 models because:

1. Our extension (vercelAiGateway) requires authentication via `VERCEL_AI_AUTH_PROVIDER_ID`
2. In a fresh test environment, there's no auth session
3. `provideLanguageModelChatInformation()` returns `[]` when no API key is available

**Options to get models in tests:**

1. **Add test API key support** - Environment variable fallback in `getApiKey()`
2. **Use system VS Code** - Has existing auth session (but can't run while VS Code is open)
3. **Mock the auth provider** - Inject a test session

**For forensic capture of conversation IDs:**

- We need ANY model (Copilot or Vercel) to call `sendRequest()`
- The response object structure is what we're investigating
- Copilot models would also work if available in the test environment

---

## CRITICAL FINDING (2026-02-01 15:27) - UPDATED 2026-02-02

**VS Code does NOT pass a conversation ID to language model providers through the stable API.**

### Initial Finding (Single-Turn Test)

Forensic capture of `ProvideLanguageModelChatResponseOptions`:

```json
{
  "options.modelOptions": {}, // EMPTY!
  "options.toolMode": 1,
  "options.tools": []
}
```

### Extended Testing (2026-02-02)

**Multi-turn conversation test** (3 sequential requests with growing message history):

- Each request gets a **different** chatId (our generated ID)
- `options.modelOptions` remains `{}` for all requests
- `vscodeEnv.sessionId` is the same across all requests (VS Code session ID)

**Subagent-style test** (fresh context with different system prompt):

- Also gets a unique chatId
- No distinguishing identifiers from VS Code

### Key Limitation of Test Harness

**IMPORTANT**: The test harness calls `model.sendRequest()` directly, which is NOT the same as what Copilot does when it invokes subagents. Copilot uses internal VS Code APIs that may pass additional context.

To capture what Copilot actually sends during subagent invocation, we would need:

1. Enable forensic capture in a real VS Code session
2. Trigger actual Copilot subagent flows (e.g., via `runSubagent` tool)
3. Analyze the captured data

### RFC 00031 Findings (Subagent Detection)

From [docs/rfcs/stage-0/00031-status-bar-design-for-subagent-flows.md](../../docs/rfcs/stage-0/00031-status-bar-design-for-subagent-flows.md):

**What We CAN Detect:**

1. **Extension Caller** (proposed API): `requestInitiator` tells us which extension made the call
2. **System Prompt Content**: Contains agent instructions, often with identity patterns
3. **Message Count**: Subagents typically have shorter conversations (1-3 messages)
4. **System Prompt Hash**: Different hash = different agent type

**What We CANNOT Detect:**

1. **Subagent Name**: No API exposes "recon", "execute", etc.
2. **Conversation ID**: No way to correlate multiple calls to one chat thread
3. **Session Boundaries**: No explicit session start/end signals

### Proposed Solution: System Prompt Fingerprinting

Since subagents have different system prompts than the main conversation:

1. Hash the system prompt to create a "fingerprint"
2. Track the first fingerprint as "main"
3. Different fingerprints = subagents

### Available Identifiers from VS Code

- `vscodeEnv.sessionId` - Unique per VS Code window (e.g., `020e7e45-c0c6-41af-b178-81b4e85bb56b...`)
- `vscodeEnv.machineId` - Stable machine identifier
- `requestInitiator` (proposed API) - Extension identifier (e.g., `github.copilot-chat`)

**The `chatId` we generate (`chat-b5374b21-1769988468775`) is our own construct, not from VS Code.**

### Implications for RFC 029 (Delta-Based Token Estimation)

This confirms that RFC 029's delta-based token estimation approach is correct:

- We cannot rely on VS Code to tell us which conversation a request belongs to
- We must infer conversation identity from message content patterns
- System prompt fingerprinting can help distinguish main conversation from subagents

---

## Test Harness Capabilities (2026-02-02)

### What the Test Harness CAN Do

1. **Make LM API calls** with various message patterns
2. **Capture forensic data** from our provider
3. **Test multi-turn conversations** (growing message history)
4. **Test different system prompt patterns**
5. **Analyze captured data** for patterns

### What the Test Harness CANNOT Do

1. **Invoke Copilot's internal subagent machinery** - Copilot uses internal VS Code APIs
2. **Simulate what Copilot passes to `sendRequest()`** when it spawns a subagent
3. **Capture real Copilot traffic** - only captures requests to our provider

### How to Capture Real Copilot Subagent Data

1. **Enable forensic capture** in user's VS Code settings (already done)
2. **Invoke the forensic-test agent**: Type `@forensic-test hello` in chat
3. **Analyze captures** using `scripts/analyze-forensic-captures.ts`

### Test Agent Created

A dedicated test agent has been created at `.github/agents/forensic-test.md`:

- Uses `model: Claude Opus 4.5 (vercelAiGateway)` to route through our provider
- Minimal instructions - just acknowledges the request
- When invoked, Copilot will call our provider and we capture the full request context

**To test**: In VS Code chat, type `@forensic-test hello` and check the forensic captures.

---

## Automated Chat Interaction (2026-02-02)

### Success: We CAN Automate Chat Interactions

The test harness can programmatically interact with VS Code's chat panel:

```typescript
// Open chat panel
await vscode.commands.executeCommand("workbench.action.chat.open");

// Create new chat
await vscode.commands.executeCommand("workbench.action.chat.newChat");

// Open chat with a query
await vscode.commands.executeCommand("workbench.action.chat.open", {
  query: "@agent-name hello",
});

// Submit the chat message
await vscode.commands.executeCommand("workbench.action.chat.submit");
```

### Available Chat Commands (202 total)

Key commands discovered:

- `workbench.action.chat.open` - Open chat panel (accepts `{query: string}`)
- `workbench.action.chat.newChat` - Start a new chat
- `workbench.action.chat.submit` - Submit current input
- `workbench.action.chat.openagent` - Open with specific agent
- `workbench.action.chat.sendToNewChat` - Send to new chat

### Limitation: Test Environment

The test VS Code instance:

- Has `--disable-extensions` (no Copilot)
- No Copilot authentication
- Chat submissions don't route to our model

### Evidence from Real Copilot Session

A capture from a real Copilot session (sequence 44) showed:

```json
{
  "messages_count": 95,
  "system_prompt_length": 22647,
  "modelOptions": {}, // STILL EMPTY!
  "sessionId": "44a40c5b-4816-4fb9-b0fb-..."
}
```

**This confirms: Even in real Copilot chat requests, `modelOptions` is empty.**

---

## DEFINITIVE FINDING (2026-02-02)

### Real Copilot Request Captured

With extensions enabled, we captured **real Copilot requests** (not simulations):

```json
{
  "sequence": 59,
  "messages_count": 36,
  "system_prompt_length": 23498,
  "modelOptions": {},           // EMPTY!
  "toolCount": 29,
  "toolNames": [
    "fetch_webpage", "file_search", "grep_search", "get_changed_files",
    "get_errors", "copilot_getNotebookSummary", "list_code_usages",
    "read_file", "semantic_search", "exo-context", "exo-phase", ...
  ]
}
```

### Conclusion

**VS Code does NOT pass conversation IDs through `options.modelOptions`.**

This is confirmed by:

1. Direct `model.sendRequest()` calls - `modelOptions: {}`
2. Automated chat submissions - `modelOptions: {}`
3. **Real Copilot requests with 36 messages and 29 tools** - `modelOptions: {}`

### Implications for Conversation Tracking

To track conversations across requests, we MUST:

1. **Generate our own conversation IDs** (current approach)
2. **Use system prompt fingerprinting** to distinguish main conversation from subagents
3. **Use message content hashing** to correlate requests

The `chatId` we generate (`chat-xxx-timestamp`) is our own construct. VS Code provides no equivalent.

### Test Results Summary (9 tests, all passing)

| Test                    | Purpose                | Finding                  |
| ----------------------- | ---------------------- | ------------------------ |
| Extension present       | Basic sanity           | ✓                        |
| Extension activate      | Activation works       | ✓                        |
| vscode.lm API           | API surface            | 18 methods available     |
| selectChatModels        | Model discovery        | 159 Vercel models        |
| Enable forensic capture | Config works           | ✓                        |
| sendRequest protocol    | Response structure     | stream + text properties |
| Multi-turn conversation | 3 sequential requests  | Each gets unique chatId  |
| Subagent-style request  | Fresh context          | Also unique chatId       |
| Analyze patterns        | Cross-request analysis | All modelOptions empty   |

### Key Commands

```bash
# Run tests
cd apps/vscode-ai-gateway
pnpm build && pnpm exec tsc -p tsconfig.test.json
VSCODE_TEST_WRAPPER=true /run/host/usr/bin/xvfb-run --auto-servernum \
  --server-args="-screen 0 1280x1024x24 -nolisten tcp" -- \
  node out/test/runTest.js 2>&1

# Analyze captures
cat ~/.vscode-ai-gateway/forensic-captures.jsonl | jq -r '[.sequence, .options.modelOptions, .systemPrompt.hash // "none"] | @tsv'

# Clear captures
echo "" > ~/.vscode-ai-gateway/forensic-captures.jsonl
```
