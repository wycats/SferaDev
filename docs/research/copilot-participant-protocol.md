# Research Plan: Copilot Participant ↔ Language Model Protocol

## Objective

Document the de-facto protocol between the Copilot Participant and Language Model Providers in VS Code. Understanding this protocol will help us:

1. Debug issues where responses stop unexpectedly
2. Ensure our provider communicates correctly with the participant
3. Implement features that "only work with Copilot" by understanding what they expect

## Architecture Context

```
┌─────────────────────────────────────────────────────────────────┐
│                    Copilot Participant                          │
│  (handles chat UI, summarization, tool orchestration, etc.)     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ LanguageModelChat API
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│               Language Model Provider (us)                      │
│  (implements LanguageModelChatProvider)                         │
└─────────────────────────────────────────────────────────────────┘
```

## Research Questions

### 1. Token Counting Protocol

- What format does the participant expect for `maxInputTokens`?
- How does it use `countTokens()` results?
- What triggers summarization? Token threshold? Message count?
- Does it expect `inputTokens` in response metadata?

### 2. Finish Reasons

- What finish reasons does the participant recognize?
- How does it handle `tool-calls` finish reason?
- Does `length` trigger any special behavior?
- What about `content-filter` or `error`?

### 3. Tool Call Protocol

- What's the expected sequence of chunks for tool calls?
- How does streaming tool calls work (`tool-call-streaming-start`, `tool-call-delta`, `tool-input-*`)?
- When does the participant decide to execute vs. display a tool call?

### 4. Error Handling

- What error types does the participant recognize?
- How can we signal "context too long" vs. "rate limited" vs. "model error"?
- Does it have retry logic? What triggers it?

### 5. Summarization Behavior

- When exactly does summarization trigger?
- What information does it use to decide?
- Can we influence when it happens?

## Research Sources

### Open Source Code

- [ ] `microsoft/vscode` - Core VS Code, LanguageModelChat API
- [ ] `microsoft/vscode-copilot-chat` - Copilot Chat extension (if any parts are open)
- [ ] Vercel AI SDK - How it formats responses

### GitHub Issues & Discussions

- [ ] Search for issues about "no response returned"
- [ ] Search for issues about summarization
- [ ] Search for issues about token limits
- [ ] Search for third-party LM provider issues

### Documentation

- [ ] VS Code API docs for LanguageModelChatProvider
- [ ] Any Copilot extension documentation
- [ ] Anthropic/OpenAI docs on finish reasons

## Methodology

1. **Code Analysis**: Read VS Code source for LanguageModelChat consumer code
2. **Issue Mining**: Search GitHub issues for behavior descriptions
3. **Experimentation**: Test our provider with different responses and observe participant behavior
4. **Logging Analysis**: Use our debug logs to correlate provider output with participant behavior

## Findings

(To be filled in as research progresses)

### Token Protocol Findings

- ...

### Finish Reason Findings

- ...

### Tool Call Findings

- ...

### Error Handling Findings

- ...

### Summarization Findings

- ...

## Recommendations

(To be filled in based on findings)
