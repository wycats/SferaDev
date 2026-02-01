---
title: Native Tool History Migration
stage: 0
feature: Unknown
exo:
  tool: exo rfc create
  protocol: 1
---

# RFC 00024: Native Tool History Migration

**Status**: Stage 0 (Draft)  
**Created**: 2025-01-30  
**Related**: PR vercel/ai-gateway#1121, GATEWAY_SPEC_GAP_REPORT.md

## Summary

Vercel AI Gateway will support `function_call` input items for tool call history, as specified in the OpenResponses specification. This RFC documents the migration from our current workaround to native tool history support.

> **⚠️ Status (2025-01-30)**: PR vercel/ai-gateway#1121 is NOT yet deployed. The Gateway still returns `400 Bad Request: Invalid input` when receiving `function_call` items. This RFC is staged for when the PR ships.

## Background

### The Original Problem

The OpenResponses specification explicitly supports `function_call` as a valid input item type, allowing clients to send tool call history as structured data:

```typescript
{
  type: 'function_call',
  call_id: 'call_abc123',
  name: 'get_weather',
  arguments: '{"location": "San Francisco"}'
}
```

However, the Vercel AI Gateway previously rejected these items with `400 Bad Request: Invalid input`.

### Our Current Workaround

The codebase handles this constraint with **two separate strategies**:

#### 1. Silent Drop in `openresponses-chat.ts`

Tool call parts from VS Code are **silently dropped** to avoid mimicry risk:

```typescript
// Current code in openresponses-chat.ts (around line 822)
} else if (part instanceof LanguageModelToolCallPart) {
  // CRITICAL: `function_call` is NOT a valid input item in OpenResponses!
  // See: packages/openresponses-client/IMPLEMENTATION_CONSTRAINTS.md
  //
  // Avoid adding any tool-call text to assistant history to reduce
  // mimicry risk. The tool result (below) carries the useful context.
}
```

Tool results are emitted as **user message text** with HTML comment markers.

#### 2. HTML Comment Format in `ToolHistoryManager`

For optional truncation/summarization, `tool-history.ts` uses HTML comments:

```typescript
// Current code in tool-history.ts (around line 212)
callText: `<!-- prior-tool: ${entry.name} | id: ${entry.callId} | args: ${argsStr} -->`,
resultText: `<!-- prior-tool-result: ${entry.callId} -->\n${entry.result}`,
```

This format was chosen to prevent models from mimicking the format.

**Downsides of current approach**:

- **Lost semantics**: Tool calls are either dropped or embedded as text
- **Context gaps**: Silent drop means model doesn't see its own prior tool calls
- **Token overhead**: HTML comments add bytes without semantic value

### The Fix

PR vercel/ai-gateway#1121 adds native support for `function_call` input items. The Gateway now:

1. Accepts `function_call` items in the input array
2. Converts them to assistant messages with `tool-call` parts for the underlying provider
3. Properly pairs them with `function_call_output` items

## Proposal

### Integration Approach: Pure `openresponses-chat.ts` Change

**Decision**: Modify only `openresponses-chat.ts` to emit native `function_call` items. The `ToolHistoryManager` remains a separate, optional component for truncation only.

This keeps concerns separated:

- **`openresponses-chat.ts`**: Message translation (VS Code → OpenResponses)
- **`tool-history.ts`**: Optional context management (truncation, summarization)

### Phase 1: Enable Native Tool History

Update `openresponses-chat.ts` message translation to emit proper `function_call` items:

```typescript
// Before (current - silent drop)
} else if (part instanceof LanguageModelToolCallPart) {
  // CRITICAL: `function_call` is NOT a valid input item in OpenResponses!
  // Avoid adding any tool-call text to assistant history.
}

// After (native)
} else if (part instanceof LanguageModelToolCallPart) {
  // Flush any pending content first
  if (contentParts.length > 0) {
    const messageItem = createMessageItem(openResponsesRole, contentParts);
    if (messageItem) items.push(messageItem);
    contentParts.length = 0;
  }

  items.push({
    type: 'function_call',
    call_id: part.callId,
    name: part.name,
    arguments: typeof part.input === 'string'
      ? part.input
      : JSON.stringify(part.input),
  });
}
```

### Phase 2: Simplify Tool History Truncation

The existing `toolHistory.recentCallsToKeep` and `toolHistory.truncationThreshold` settings remain useful for context management, but the implementation simplifies:

| Current Behavior                    | New Behavior                                    |
| ----------------------------------- | ----------------------------------------------- |
| Summarize old tool calls as text    | Keep as `function_call` items, just drop oldest |
| Complex text parsing for truncation | Simple array slicing                            |
| Token estimation for text summaries | Direct item counting                            |

**Keep the config options** - users may still want to limit tool history for context budget reasons:

```json
{
  "vercelAiGateway.toolHistory.recentCallsToKeep": 6,
  "vercelAiGateway.toolHistory.truncationThreshold": 10000
}
```

### Phase 3: Documentation Cleanup

| Document                         | Action                             |
| -------------------------------- | ---------------------------------- |
| `GATEWAY_SPEC_GAP_REPORT.md`     | Archive or delete (gap is closed)  |
| `IMPLEMENTATION_CONSTRAINTS.md`  | Remove `function_call` restriction |
| `message-translation-mapping.md` | Update to show native translation  |
| `tool-history.ts`                | Simplify truncation logic          |

## Migration Strategy

### Compatibility

The change is **forward-compatible**:

- Old clients using text embedding will continue to work
- New clients using `function_call` items will work with updated Gateway
- No breaking changes to the VS Code extension API

### Rollout

1. **Feature flag**: Add `vercelAiGateway.experimental.nativeToolHistory` (default: false)
2. **Testing phase**: Enable for internal testing
3. **GA**: Default to true, deprecate flag

### Fallback

If the Gateway rejects `function_call` items (older deployment), fall back to text embedding:

```typescript
try {
  await sendWithNativeToolHistory(items);
} catch (error) {
  if (isInvalidInputError(error)) {
    logger.warn("Native tool history rejected, falling back to text embedding");
    await sendWithTextEmbedding(items);
  }
  throw error;
}
```

## Files Affected

### Must Change

| File                                 | Change                                                              |
| ------------------------------------ | ------------------------------------------------------------------- |
| `src/provider/openresponses-chat.ts` | Emit `function_call` items instead of silent drop (around line 822) |
| `IMPLEMENTATION_CONSTRAINTS.md`      | Remove `function_call` restriction                                  |

### Optional (Phase 2)

| File                                | Change                                                          |
| ----------------------------------- | --------------------------------------------------------------- |
| `src/provider/tool-history.ts`      | Simplify to work with structured items instead of HTML comments |
| `src/provider/tool-history.test.ts` | Update expectations for new format                              |

### Should Update

| File                             | Change                       |
| -------------------------------- | ---------------------------- |
| `message-translation-mapping.md` | Document native translation  |
| `GATEWAY_SPEC_GAP_REPORT.md`     | Archive with resolution note |

### Keep As-Is

| File                                     | Reason                              |
| ---------------------------------------- | ----------------------------------- |
| `config.ts` toolHistory settings         | Still useful for context management |
| `package.json` toolHistory contributions | Settings remain valid               |

## Acceptance Criteria

- [ ] `node scripts/test-openresponses.ts tool-call-result` passes (currently returns 400)
- [ ] Multi-turn tool conversations work end-to-end in VS Code
- [ ] Fallback activates on older Gateway deployments (400 → silent drop)
- [ ] Existing tests continue to pass (`pnpm test` in vscode-ai-gateway)

## Testing

1. **Unit tests**: Update tool history tests to expect `function_call` items
2. **Integration tests**: Verify round-trip with real Gateway using `scripts/test-openresponses.ts`
3. **Regression tests**: Ensure fallback works for older deployments

### Key Test Cases

| Test                    | File                    | Expected Outcome                       |
| ----------------------- | ----------------------- | -------------------------------------- |
| `tool-call-result`      | `test-openresponses.ts` | Should pass after Gateway fix          |
| `tool-embedded`         | `test-openresponses.ts` | Fallback path, should continue to pass |
| Tool history formatting | `tool-history.test.ts`  | Update expectations for new format     |

## Open Questions

1. **Gateway version detection**: How do we detect if the Gateway supports native tool history?
   - Option A: Try native, fall back on error
   - Option B: Check Gateway version header
   - Option C: Configuration flag

2. **Token counting**: With native items, how do we estimate token usage for truncation?
   - The items are still converted to text by the provider
   - May need heuristic: `name.length + arguments.length * 0.25`

3. **Truncation granularity**: Should we truncate entire tool call + output pairs, or individually?
   - Orphaned `function_call_output` items may confuse the model
   - Recommendation: Always drop as pairs

## Success Metrics

- Reduced token usage for multi-turn tool conversations
- Simplified codebase (remove text embedding logic)
- Better model understanding of tool call history
