# Token Counting Architecture Analysis

## Overview

This document maps all the moving parts involved in token counting for the VS Code Language Model API, specifically tracing how `provideTokenCount` flows through the system.

## Components

### 1. OUR EXTENSION (vscode-ai-gateway) - OPEN SOURCE

**Location:** `packages/vscode-ai-gateway/`

**Key Files:**

- `src/provider.ts` - Implements `LanguageModelChatProvider`

**Role:**

- Registers models via `vscode.lm.registerLanguageModelChatProvider()`
- Implements `provideTokenCount(model, text, token)`
- Communicates with OpenResponses gateway

**Token Counting Implementation:**

```typescript
provideTokenCount(model, text, token): Promise<number> {
  // Uses tiktoken for estimation
  // Applies correction factors
  // Returns inflated count when learned from errors
}
```

---

### 2. VS CODE CORE (microsoft/vscode) - OPEN SOURCE

**Location:** `.reference/vscode/`

**Key Files:**

- `src/vs/workbench/api/common/extHostLanguageModels.ts` (Extension Host)
- `src/vs/workbench/api/browser/mainThreadLanguageModels.ts` (Main Thread)
- `src/vs/workbench/contrib/chat/common/languageModels.ts` (Service)

#### Extension Host Side (`extHostLanguageModels.ts`)

**`$provideTokenLength` (line 341)** - Called by Main Thread:

```typescript
$provideTokenLength(modelId, value, token): Promise<number> {
  const knownModel = this._localModels.get(modelId);
  const data = this._languageModelProviders.get(knownModel.metadata.vendor);
  return data.provider.provideTokenCount(knownModel.info, value, token);
}
```

**`_computeTokenLength` (line 577)** - Called by `countTokens` API:

```typescript
private async _computeTokenLength(modelId, value, token): Promise<number> {
  const data = this._localModels.get(modelId);
  return this._languageModelProviders.get(data.metadata.vendor)
    ?.provider.provideTokenCount(data.info, value, token) ?? 0;
}
```

**`countTokens` API (line 418)** - Exposed to extensions:

```typescript
countTokens(text, token) {
  return that._computeTokenLength(modelId, text, token);
}
```

#### Main Thread Side (`mainThreadLanguageModels.ts`)

**Provider Registration (line 96):**

```typescript
provideTokenCount: (modelId, str, token) => {
  return this._proxy.$provideTokenLength(modelId, str, token);
};
```

**`$countTokens` (line 182):**

```typescript
$countTokens(modelId, value, token): Promise<number> {
  return this._chatProviderService.computeTokenLength(modelId, value, token);
}
```

#### Service (`languageModels.ts`)

**`ILanguageModelsService.computeTokenLength`:**

```typescript
computeTokenLength(modelId, message, token): Promise<number> {
  const provider = this._providers.get(model.vendor);
  return provider.provideTokenCount(modelId, message, token);
}
```

---

### 3. COPILOT CHAT EXTENSION (microsoft/vscode-copilot-chat) - OPEN SOURCE

**Location:** `.reference/vscode-copilot-chat/`

**Key Files:**

- `src/extension/intents/node/agentIntent.ts` - Summarization trigger
- `src/platform/tokenizer/node/tokenizer.ts` - BPE tokenizer
- `src/extension/prompts/node/base/promptRenderer.ts` - Prompt rendering
- `src/extension/conversation/vscode-node/languageModelAccess.ts` - Model access

#### Token Counting in Copilot

**Copilot uses its OWN tokenizer** (`tokenizer.ts`):

- `BPETokenizer` class using tiktoken (cl100k/o200k)
- Used by `PromptRenderer` for budget enforcement
- Does NOT call `provideTokenCount` from providers

**Summarization Trigger** (`agentIntent.ts` lines 232-257):

```typescript
// For Anthropic models with context editing:
const promptTokens =
  currentTurnTokenUsage?.promptTokens ??
  previousTurn?.resultMetadata?.promptTokens;
const outputTokens =
  currentTurnTokenUsage?.outputTokens ??
  previousTurn?.resultMetadata?.outputTokens;

if (promptTokens !== undefined && outputTokens !== undefined) {
  const totalEstimatedTokens = (promptTokens + outputTokens) * 1.15;
  if (totalEstimatedTokens > this.endpoint.modelMaxPromptTokens) {
    shouldTriggerSummarize = true;
  }
}
```

**Key Insight:** The trigger uses **API response metadata** (`promptTokens`, `outputTokens`), NOT `provideTokenCount`.

---

### 4. COPILOT EXTENSION (github.copilot) - CLOSED SOURCE ⚠️

**Location:** Installed extension, not accessible

**What we DON'T know:**

- Internal token counting logic
- How it interacts with Copilot Chat
- Whether it has additional budget enforcement

---

### 5. OPENRESPONSES GATEWAY - EXTERNAL

**Location:** External service

**Role:**

- Receives requests from our extension
- Has its own tokenizer (may differ from tiktoken)
- Returns "input too long" errors when context exceeds limit
- Returns `usage.prompt_tokens` in response metadata

---

## Token Counting Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           USER SENDS MESSAGE                                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    COPILOT CHAT (vscode-copilot-chat)                        │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ agentIntent.ts: Check if summarization needed                        │    │
│  │                                                                      │    │
│  │ IF Anthropic + context editing:                                      │    │
│  │   Use previousTurn.resultMetadata.promptTokens (from API response)   │    │
│  │ ELSE:                                                                │    │
│  │   safeBudget = budgetThreshold (85% of modelMaxPromptTokens)         │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                    │                                         │
│                                    ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ PromptRenderer: Build prompt within budget                           │    │
│  │                                                                      │    │
│  │ IF model has countTokens:                                            │    │
│  │   Uses: VSCodeTokenizer → model.countTokens() → provideTokenCount()  │    │
│  │ ELSE:                                                                │    │
│  │   Uses: BPETokenizer (tiktoken cl100k/o200k)                        │    │
│  │                                                                      │    │
│  │ IF tokens > budget: throw BudgetExceededError                        │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                    │                                         │
│                                    ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ IF BudgetExceededError && summarizationEnabled:                      │    │
│  │   → Trigger summarization                                            │    │
│  │   → Re-render prompt                                                 │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         VS CODE CORE (vscode)                                │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ ILanguageModelsService.sendChatRequest()                             │    │
│  │                                                                      │    │
│  │ Routes to registered provider based on model vendor                  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                    │                                         │
│                                    ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ mainThreadLanguageModels.ts                                          │    │
│  │                                                                      │    │
│  │ $tryStartChatRequest() → _proxy.$startChatRequest()                  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                    │                                         │
│                                    ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ extHostLanguageModels.ts                                             │    │
│  │                                                                      │    │
│  │ $startChatRequest() → provider.provideLanguageModelChatResponse()    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    OUR EXTENSION (vscode-ai-gateway)                         │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ provider.ts: provideLanguageModelChatResponse()                      │    │
│  │                                                                      │    │
│  │ 1. Build request for OpenResponses                                   │    │
│  │ 2. Send to gateway                                                   │    │
│  │ 3. Stream response back                                              │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       OPENRESPONSES GATEWAY                                  │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ Gateway tokenizer (may differ from tiktoken)                         │    │
│  │                                                                      │    │
│  │ IF input too long: Return error                                      │    │
│  │ ELSE: Process request, return response with usage metadata           │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Where `provideTokenCount` IS Called

Based on code analysis, `provideTokenCount` is called in these scenarios:

### 1. Extension API: `model.countTokens()`

When any extension calls `model.countTokens()`:

```
Extension → LanguageModelChat.countTokens()
  → extHostLanguageModels._computeTokenLength()
  → provider.provideTokenCount()
```

### 2. Main Thread: `$countTokens`

When main thread needs token count:

```
MainThread → $countTokens()
  → ILanguageModelsService.computeTokenLength()
  → provider.provideTokenCount()
```

### 3. Extension Host: `$provideTokenLength`

When main thread requests token length:

```
MainThread → _proxy.$provideTokenLength()
  → extHostLanguageModels.$provideTokenLength()
  → provider.provideTokenCount()
```

---

## Where `provideTokenCount` is NOT Called

### Copilot Chat's Internal Token Counting

- `PromptRenderer` uses `BPETokenizer` (tiktoken)
- Does NOT call `provideTokenCount`
- Budget enforcement is local to Copilot

### Summarization Trigger (Anthropic path)

- Uses `previousTurn.resultMetadata.promptTokens`
- This comes from API response, not `provideTokenCount`

---

## MYSTERY SOLVED ✅

### Observed Behavior

- **Before:** No summarization, gateway "input too long" errors
- **After:** Summarization works

### The Answer

Analysis of the **minified Copilot extension** (`~/.vscode/extensions/github.copilot-1.388.0/dist/extension.js`) reveals the connection:

```javascript
// In renderPrompt function (gUn):
async function gUn(t,e,n,a,r,o,c=cDe.OutputMode.VSCode){
  let l = "countTokens" in a
    ? new pUn.VSCodeTokenizer((m,g) => a.countTokens(m,g), c)
    : a,
  ...
}
```

**The flow:**

1. Copilot calls `vscode.lm.selectChatModels()` to get a `LanguageModelChat` object
2. When rendering prompts, Copilot checks if the model has `countTokens` method
3. If yes, it creates a `VSCodeTokenizer` that wraps `model.countTokens()`
4. `model.countTokens()` internally calls our `provideTokenCount()` via VS Code's extension host

**Why it matters:**

- Without `provideTokenCount`: Copilot falls back to its internal BPE tokenizer
- The internal BPE tokenizer may have different token counts than the actual model
- With `provideTokenCount`: Copilot uses accurate token counts from our provider
- Accurate token counts → proper budget enforcement → summarization triggers at right time

**Evidence from minified code:**

```javascript
// VSCodeTokenizer class
iDe = class {
  static {
    s(this, "VSCodeTokenizer");
  }
  countTokens;
  mode = rDe.OutputMode.VSCode;
  constructor(e, n) {
    if (((this.countTokens = e), n !== rDe.OutputMode.VSCode))
      throw new Error(
        "`mode` must be set to vscode when using vscode.LanguageModelChat as the tokenizer",
      );
  }
  async tokenLength(e, n) {
    return e.type === rDe.Raw.ChatCompletionContentPartKind.Text
      ? this.countTokens(e.text, n)
      : Promise.resolve(0);
  }
  async countMessageTokens(e) {
    return this.countTokens(e);
  }
};
```

### The Complete Call Chain

```
Copilot renderPrompt()
  → checks "countTokens" in model
  → creates VSCodeTokenizer((m,g) => model.countTokens(m,g))
  → VSCodeTokenizer.tokenLength()
  → model.countTokens()
  → VS Code Extension Host
  → extHostLanguageModels._computeTokenLength()
  → provider.provideTokenCount()  ← OUR CODE
```

### Why Open-Source Search Missed This

1. **Copilot Chat** (`vscode-copilot-chat`) uses its own BPE tokenizer for internal budget
2. **Copilot** (`github.copilot`) is closed-source but the minified JS is readable
3. The key code is in the **distributed extension**, not the open-source repos
4. The `countTokens` check happens at runtime, not compile time

---

## Closed Source Gaps (Now Understood)

### github.copilot Extension

- ✅ **FOUND:** Uses `VSCodeTokenizer` wrapper when model has `countTokens`
- ✅ **FOUND:** Falls back to internal tokenizer when `countTokens` unavailable
- The minified code is readable enough to trace the flow

### OpenResponses Gateway

- Tokenizer implementation unknown
- May differ from tiktoken
- Error response format may vary

---

## Recommendations

1. ✅ **Mystery solved** - `provideTokenCount` IS being called via `model.countTokens()`
2. **Ensure accurate token counts** - Our tiktoken should match the model's actual tokenizer
3. **Consider the 1.5x multiplier** - May need adjustment based on actual gateway behavior
4. **Monitor for tokenizer drift** - Different models may have different tokenizers

---

## References

- VS Code Source: `.reference/vscode/`
- Copilot Chat Source: `.reference/vscode-copilot-chat/`
- Our Extension: `packages/vscode-ai-gateway/`
