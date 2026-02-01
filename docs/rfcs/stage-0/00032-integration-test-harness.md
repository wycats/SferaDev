---
title: Integration Test Harness
stage: 0
feature: testing
exo:
    tool: exo rfc create
    protocol: 1
---

# RFC 00032: Integration Test Harness

**Status**: Draft  
**Created**: 2026-02-01

## Problem Statement

We need to empirically discover unique conversation identifiers for the VS Code Language Model API. The current approach uses `systemPromptHash` as `conversationId`, but this isn't unique per conversation—parallel chats with the same system prompt collide.

### Current Limitations

1. **Unit tests use mocked vscode**: Existing Vitest tests in `src/*.test.ts` mock the VS Code API, so they cannot exercise real LM behavior.
2. **No real API access**: We cannot call `vscode.lm.selectChatModels()` or `model.sendRequest()` in unit tests.
3. **Forensic capture untested**: The forensic capture system is wired in but never exercised in automated tests.
4. **Conversation ID hypothesis untested**: We hypothesize that certain fields (message hashes, tool schemas, etc.) could serve as conversation identifiers, but we have no automated way to validate this.

## Goals

1. **Real API Access**: Launch VS Code with our extension installed and call the LM API directly.
2. **Forensic Capture Validation**: Verify that forensic captures are written correctly.
3. **Conversation ID Discovery**: Run multiple parallel conversations and analyze captured data for unique identifiers.
4. **CI Integration**: Tests should run in CI (headless mode with xvfb).

## Non-Goals

- Testing the Vercel AI Gateway backend (out of scope)
- Testing model response quality (out of scope)
- Replacing existing unit tests (complementary, not replacement)

## Design

### Test Infrastructure

```
apps/vscode-ai-gateway/
├── src/
│   └── test/
│       ├── runTest.ts          # Test runner (launches VS Code)
│       ├── suite/
│       │   ├── index.ts        # Test suite entry point
│       │   └── forensic-capture.test.ts
│       └── fixtures/           # Test data
```

### Test Runner (`runTest.ts`)

Uses `@vscode/test-electron` to:
1. Download VS Code (if needed)
2. Install the extension under test
3. Launch VS Code in Extension Development Host mode
4. Run the test suite
5. Exit with test results

```typescript
import { runTests } from '@vscode/test-electron';
import * as path from 'path';

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      '--disable-extensions', // Disable other extensions
      '--skip-welcome',
      '--skip-release-notes',
    ],
  });
}

main().catch(console.error);
```

### Test Suite Entry Point (`suite/index.ts`)

Uses Mocha (standard for VS Code extension tests):

```typescript
import * as Mocha from 'mocha';
import * as path from 'path';
import * as glob from 'glob';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 60000 });
  const testsRoot = path.resolve(__dirname, '.');

  return new Promise((resolve, reject) => {
    glob('**/**.test.js', { cwd: testsRoot }, (err, files) => {
      if (err) return reject(err);
      files.forEach(f => mocha.addFile(path.resolve(testsRoot, f)));
      mocha.run(failures => failures > 0 ? reject(new Error(`${failures} tests failed`)) : resolve());
    });
  });
}
```

### Forensic Capture Test (`forensic-capture.test.ts`)

```typescript
import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

suite('Forensic Capture Integration', () => {
  const captureFile = path.join(os.homedir(), '.vscode-ai-gateway', 'forensic-captures.jsonl');

  setup(async () => {
    // Enable forensic capture
    const config = vscode.workspace.getConfiguration('vercelAiGateway');
    await config.update('debug.forensicCapture', true, vscode.ConfigurationTarget.Global);
    
    // Clear existing captures
    if (fs.existsSync(captureFile)) {
      fs.unlinkSync(captureFile);
    }
  });

  teardown(async () => {
    // Disable forensic capture
    const config = vscode.workspace.getConfiguration('vercelAiGateway');
    await config.update('debug.forensicCapture', false, vscode.ConfigurationTarget.Global);
  });

  test('captures data when LM API is called', async function() {
    // Skip if no models available
    const models = await vscode.lm.selectChatModels({ vendor: 'vercelAiGateway' });
    if (models.length === 0) {
      this.skip();
      return;
    }

    const model = models[0];
    const messages = [vscode.LanguageModelChatMessage.User('Hello, world!')];
    
    // Make a request
    const response = await model.sendRequest(messages, {});
    
    // Consume the stream
    for await (const chunk of response.stream) {
      // Just consume
    }

    // Verify capture file exists and has content
    assert.ok(fs.existsSync(captureFile), 'Capture file should exist');
    const content = fs.readFileSync(captureFile, 'utf-8');
    const lines = content.trim().split('\n');
    assert.ok(lines.length >= 1, 'Should have at least one capture');

    const capture = JSON.parse(lines[0]);
    assert.ok(capture.sequence >= 1, 'Should have sequence number');
    assert.ok(capture.vscodeEnv.sessionId, 'Should capture sessionId');
    assert.ok(capture.model.id, 'Should capture model id');
  });

  test('parallel conversations have distinguishable captures', async function() {
    const models = await vscode.lm.selectChatModels({ vendor: 'vercelAiGateway' });
    if (models.length === 0) {
      this.skip();
      return;
    }

    const model = models[0];
    
    // Start two parallel conversations
    const conv1 = model.sendRequest([
      vscode.LanguageModelChatMessage.User('Conversation 1: What is 2+2?')
    ], {});
    
    const conv2 = model.sendRequest([
      vscode.LanguageModelChatMessage.User('Conversation 2: What is the capital of France?')
    ], {});

    // Consume both streams
    await Promise.all([
      (async () => { for await (const _ of (await conv1).stream) {} })(),
      (async () => { for await (const _ of (await conv2).stream) {} })(),
    ]);

    // Analyze captures
    const content = fs.readFileSync(captureFile, 'utf-8');
    const captures = content.trim().split('\n').map(l => JSON.parse(l));
    
    assert.strictEqual(captures.length, 2, 'Should have two captures');
    
    // Check that message hashes differ
    const hash1 = captures[0].messages.contentSummary[0].hash;
    const hash2 = captures[1].messages.contentSummary[0].hash;
    assert.notStrictEqual(hash1, hash2, 'Message hashes should differ');
  });
});
```

### CI Configuration

For GitHub Actions (Linux):

```yaml
- name: Run integration tests
  run: xvfb-run -a pnpm test:integration
  working-directory: apps/vscode-ai-gateway
```

## Test Scenarios

| Scenario | Purpose | Expected Outcome |
|----------|---------|------------------|
| Single request | Verify basic capture | Capture file created with valid JSON |
| Parallel requests | Test conversation isolation | Different message hashes captured |
| Multi-turn conversation | Test conversation continuity | Same system prompt hash, increasing message counts |
| No models available | Graceful degradation | Test skipped, not failed |
| Forensic capture disabled | Verify opt-in | No capture file created |

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| No LM models in CI | Skip tests gracefully; document manual testing |
| Flaky due to timing | Use generous timeouts; retry logic |
| xvfb issues on CI | Document runner requirements; test on multiple CI providers |
| Extension activation race | Wait for extension to activate before tests |

## Success Criteria

1. `pnpm test:integration` runs successfully locally
2. Tests skip gracefully when no models available
3. Forensic captures are written and readable
4. Analysis script can process test-generated captures

## Implementation Phases

### Phase 1: Test Infrastructure Setup
- Add `@vscode/test-electron` and `mocha` dependencies
- Create test runner (`src/test/runTest.ts`)
- Create test suite entry point (`src/test/suite/index.ts`)
- Add `test:integration` script to package.json
- Update tsconfig.json for test files

### Phase 2: Forensic Integration Tests
- Create `src/test/suite/forensic-capture.test.ts`
- Add parallel conversation test
- Add graceful skip logic when no LM models available
- Add test setup/teardown to clear forensic captures

### Phase 3: Analysis Integration
- Create analysis test that runs `analyze-forensic-captures.ts` after capture tests
- Add GitHub Actions workflow step for integration tests with xvfb
- Add README section documenting how to run integration tests locally

## Future Work

- Add tests for subagent detection (requires Copilot interaction)
- Add tests for tool call scenarios
- Add performance benchmarks for token estimation
