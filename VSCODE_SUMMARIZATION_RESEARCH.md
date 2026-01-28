# VS Code Conversation Summarization Protocol Research

## Status: COMPLETED (Phase 1)

## Goal

Understand how VS Code expects language model providers to communicate token information so that the "summarize conversation" feature triggers.

## Key Questions

1. What triggers conversation summarization?
2. How does VS Code track token usage?
3. What protocol/API does VS Code use to communicate with language model providers about context limits?
4. What does a language model provider need to implement to support summarization?

---

## Research Findings

### Phase 1: Key Interfaces Found

#### ChatSummarizer Interface (Proposed API)

Location: `src/vscode-dts/vscode.proposed.defaultChatParticipant.d.ts`

```typescript
export interface ChatSummarizer {
  provideChatSummary(
    context: ChatContext,
    token: CancellationToken,
  ): ProviderResult<string>;
}

export interface ChatParticipant {
  // ...
  summarizer?: ChatSummarizer;
}
```

**Key Finding**: The `ChatSummarizer` is a **proposed API** that requires the `defaultChatParticipant` proposal to be enabled.

#### IChatAgentImplementation Interface

Location: `src/vs/workbench/contrib/chat/common/participants/chatAgents.ts`

```typescript
export interface IChatAgentImplementation {
    invoke(...): Promise<IChatAgentResult>;
    setRequestTools?(...): void;
    provideFollowups?(...): Promise<IChatFollowup[]>;
    provideChatTitle?: (history: IChatAgentHistoryEntry[], token: CancellationToken) => Promise<string | undefined>;
    provideChatSummary?: (history: IChatAgentHistoryEntry[], token: CancellationToken) => Promise<string | undefined>;
}
```

#### ExtHost Implementation

Location: `src/vs/workbench/api/common/extHostChatAgents2.ts`

```typescript
async provideSummary(context: vscode.ChatContext, token: CancellationToken): Promise<string | undefined> {
    if (!this._summarizer) {
        return;
    }
    return await this._summarizer.provideChatSummary(context, token) ?? undefined;
}
```

### Phase 2: Token Usage Reporting

#### IChatAgentResultUsage Interface

Location: `src/vs/workbench/contrib/chat/common/participants/chatAgents.ts`

```typescript
export interface IChatAgentPromptTokenDetail {
  category: string;
  label: string;
  percentageOfPrompt: number;
}

export interface IChatAgentResultUsage {
  promptTokens: number;
  completionTokens: number;
  promptTokenDetails?: readonly IChatAgentPromptTokenDetail[];
}

export interface IChatAgentResult {
  errorDetails?: IChatResponseErrorDetails;
  timings?: IChatAgentResultTimings;
  readonly metadata?: { readonly [key: string]: unknown };
  readonly details?: string;
  nextQuestion?: IChatQuestion;
  /** Token usage information for this request */
  readonly usage?: IChatAgentResultUsage;
}
```

**Key Finding**: Token usage is reported via `IChatAgentResult.usage` which includes `promptTokens` and `completionTokens`.

#### ChatContextUsageWidget

Location: `src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts`

The widget displays context/token usage:

```typescript
private updateFromResponse(response: IChatResponseModel, modelId: string): void {
    const usage = response.result?.usage;
    const modelMetadata = this.languageModelsService.lookupLanguageModel(modelId);
    const maxInputTokens = modelMetadata?.maxInputTokens;

    if (!usage || !maxInputTokens || maxInputTokens <= 0) {
        this.hide();
        return;
    }

    const promptTokens = usage.promptTokens;
    const promptTokenDetails = usage.promptTokenDetails;
    const percentage = Math.min(100, (promptTokens / maxInputTokens) * 100);

    this.render(percentage, promptTokens, maxInputTokens, promptTokenDetails);
    this.show();
}
```

### Phase 3: LanguageModelError Class

Location: `src/vs/workbench/api/common/extHostTypes.ts`

```typescript
export class LanguageModelError extends Error {
  static readonly #name = "LanguageModelError";

  static NotFound(message?: string): LanguageModelError {
    return new LanguageModelError(message, LanguageModelError.NotFound.name);
  }

  static NoPermissions(message?: string): LanguageModelError {
    return new LanguageModelError(
      message,
      LanguageModelError.NoPermissions.name,
    );
  }

  static Blocked(message?: string): LanguageModelError {
    return new LanguageModelError(message, LanguageModelError.Blocked.name);
  }

  readonly code: string;

  constructor(message?: string, code?: string, cause?: Error) {
    super(message, { cause });
    this.name = LanguageModelError.#name;
    this.code = code ?? "";
  }
}
```

**Key Finding**: `LanguageModelError` has predefined error types: `NotFound`, `NoPermissions`, `Blocked`.
There is NO `ContextWindowExceeded` or similar error type in the current VS Code API!

### Phase 4: Summarization Trigger Analysis

#### CRITICAL FINDING: `getChatSummary` is NOT called anywhere in VS Code!

After extensive code search, I found that:

1. `getChatSummary` is **defined** in `IChatAgentService` interface
2. `getChatSummary` is **implemented** in `ChatAgentService`
3. `provideChatSummary` is **wired up** in the ExtHost protocol
4. **BUT `getChatSummary` is NEVER CALLED** anywhere in the VS Code codebase!

This means the summarization feature is:

- **Designed** but **not yet implemented** in VS Code core
- The infrastructure exists (interfaces, wiring) but no trigger mechanism is present
- The feature appears to be intended for the **GitHub Copilot extension** to implement internally

### Phase 5: Language Model Metadata

Location: `src/vs/workbench/contrib/chat/common/languageModels.ts`

```typescript
export interface ILanguageModelChatMetadata {
  readonly vendor: string;
  readonly name: string;
  readonly id: string;
  readonly family: string;
  readonly version: string;
  readonly maxInputTokens: number; // <-- Key property for context window
  readonly maxOutputTokens: number;
  // ...
}
```

The `maxInputTokens` property is used by the `ChatContextUsageWidget` to calculate and display the percentage of context window used.

---

## ⚠️ CORRECTION: Summarization IS Implemented

**The original research was incorrect.** Summarization IS implemented and actively used—but in the **GitHub Copilot Chat extension**, not VS Code core. The extension source code is now available at `microsoft/vscode-copilot-chat`.

---

## How It Actually Works

### Architecture: Separation of Concerns

| Component                      | Responsibility                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------- |
| **VS Code Core**               | UI display (`ChatContextUsageWidget`), API infrastructure, token tracking         |
| **Language Model Provider**    | Report `maxInputTokens`, implement `provideTokenCount`, return usage in responses |
| **Chat Participant (Copilot)** | ALL summarization logic—when to trigger, how to summarize, managing history       |

### For Language Model Providers

**You do NOT implement summarization.** The Copilot participant handles all summarization using your model's metadata.

Your only responsibilities:

1. **Report accurate model metadata:**

   ```typescript
   {
     maxInputTokens: 128000,  // Critical: Copilot uses this to know when to summarize
     maxOutputTokens: 4096,
   }
   ```

2. **Implement token counting** (optional but helpful):

   ```typescript
   provideTokenCount(text: string | vscode.LanguageModelChatMessage, token: vscode.CancellationToken): Thenable<number>
   ```

3. **Return token usage in responses** (optional):
   ```typescript
   {
     promptTokens: actualPromptTokens,
     completionTokens: actualCompletionTokens,
   }
   ```

### How Copilot Uses Your Model Metadata

From `microsoft/vscode-copilot-chat`:

1. **`SummarizedConversationHistory`** tracks conversation and monitors token usage
2. When token count approaches `maxInputTokens`, it triggers `ConversationHistorySummarizer`
3. Summarization uses the **same language model** you provided (or `copilot-fast` for delegation scenarios)
4. The summarization prompt asks the model to:
   - Output a short history summary
   - Preserve all referenced files/symbols
   - Note the previous summary if one exists

**The summarization prompt (actual code):**

```
Write a short summary of the conversation so far.
You only output the summary.
- Limit to 3 key points
- Include all file paths and symbol names that were referenced
- The summary should mention specific details, not general statements
- If previous summary exists, incorporate important information from it
```

---

## ChatContextUsageWidget: Where It Appears

The widget displays as a **circular pie chart** in the chat input area:

- **Location**: Bottom of chat panel, next to the input box
- **Collapsed view**: Small circular progress indicator showing percentage filled
- **Expanded view**: Shows "X / Y T" (e.g., "120 / 128 T" for 120K of 128K tokens)
- **Color coding**:
  - Default: Normal color
  - Warning (75%+): Yellow/warning color
  - Error (90%+): Red/error color

The widget reads `maxInputTokens` from the currently selected language model and `promptTokens` from the last chat response.

---

## Example: Third-Party Language Model Provider

From **VicBilibily/GCMP** (Generic Copilot Model Provider):

```typescript
export class GenericModelProvider implements vscode.LanguageModelChatProvider {
  metadata: LanguageModelChatMetadata = {
    name: "GPT-4o",
    vendor: "OpenAI",
    family: "gpt-4o",
    version: "2024-08-06",
    maxInputTokens: 128000, // ← Critical for summarization trigger
    maxOutputTokens: 16384,
    isDefault: false,
    targetExtensions: ["github.copilot-chat"],
  };

  provideLanguageModelResponse(
    messages: vscode.LanguageModelChatMessage[],
    options: LanguageModelResponseProviderOptions,
    extensionId: string,
    progress: Progress<LanguageModelChatResponse>,
    token: vscode.CancellationToken,
  ): Thenable<ILanguageModelChatResult | undefined> {
    // Call your backend, stream response via progress
    // Optionally return { usage: { promptTokens, completionTokens } }
  }

  provideTokenCount(
    text: string | vscode.LanguageModelChatMessage,
    token: vscode.CancellationToken,
  ): Thenable<number> {
    // Return estimated token count for the text
  }
}
```

**Note:** This provider does NOT implement any summarization logic—that's handled by the Copilot participant.

---

## The `ChatSummarizer` API

This is a **proposed API** requiring `defaultChatParticipant` enablement:

```typescript
export interface ChatSummarizer {
  provideChatSummary(
    context: ChatSummaryContext,
    token: CancellationToken,
  ): ProviderResult<string>;
}

export interface ChatParticipant {
  summarizer?: ChatSummarizer; // Only for default participant
}
```

**Who implements this?** The Copilot Chat extension implements `ChatSummarizerProvider`:

```typescript
// From microsoft/vscode-copilot-chat summarizer.ts
export class ChatSummarizerProvider implements vscode.ChatSummarizer {
  async provideChatSummary(
    context: vscode.ChatSummaryContext,
    token: vscode.CancellationToken,
  ) {
    // Uses copilot-fast endpoint
    return await this.generateSummary(context.history, token);
  }
}
```

**Who calls it?** The `ChatDelegationSummaryService` calls it when delegating tasks to the coding agent:

```typescript
// Simplified from delegationSummaryService.ts
const summarizer = this.chatParticipant.summarizer;
if (summarizer) {
  const summary = await summarizer.provideChatSummary({ history }, token);
  // Send summary to coding agent instead of full history
}
```

---

## Summary: What You Need to Do

### If You're Building a Language Model Provider

1. ✅ Report accurate `maxInputTokens` in metadata
2. ✅ Optionally implement `provideTokenCount` for better estimates
3. ✅ Optionally return `usage` in chat results
4. ❌ Do NOT implement summarization logic

### If You're Building a Chat Participant

1. Summarization is your responsibility
2. Track token usage against model's `maxInputTokens`
3. Trigger summarization when approaching the limit
4. Implement `ChatSummarizer` interface if using proposed API

---

## Appendix: Key File Locations

### VS Code Core (`microsoft/vscode`)

- **Context Usage Widget**: `src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts`
- **Chat Agent Service**: `src/vs/workbench/contrib/chat/common/participants/chatAgents.ts`
- **Language Models**: `src/vs/workbench/contrib/chat/common/languageModels.ts`
- **Proposed API (Summarizer)**: `src/vscode-dts/vscode.proposed.defaultChatParticipant.d.ts`

### Copilot Chat Extension (`microsoft/vscode-copilot-chat`)

- **Summarized History**: `chat/context/summarizedConversationHistory.tsx`
- **Summarizer Provider**: `services/summarizer.ts`
- **Delegation Summary**: `services/delegationSummaryService.ts`
- **Language Model Access**: `services/languageModelAccess.ts`

### Third-Party Providers (GitHub)

- **GCMP**: `VicBilibily/GCMP` - Full-featured generic model provider
- **OAI2LMApi**: `hugefiver/OAI2LMApi` - OpenAI-compatible provider
- **local-model-provider**: `krevas/local-model-provider` - Local model support
