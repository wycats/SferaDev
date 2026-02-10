# Codex 5.x / VS Code Alignment Research

**Date**: 2025-07-18
**Source**: [OpenAI Codex Prompting Guide](https://cookbook.openai.com/examples/gpt-5/codex_prompting_guide)
**Goal**: Determine what, if anything, the AI Gateway extension can do to make VS Code more hospitable to Codex 5.x models.

---

## Executive Summary

The Codex 5.x prompting guide recommends specific tools (`apply_patch`, `shell_command`, `update_plan`), a structured system prompt, parallel tool-calling patterns, and conversation compaction. **VS Code's Copilot Chat extension already handles most of these concerns** — it has model-specific system prompts, per-model edit tool selection, and built-in conversation summarization.

The single highest-impact action is **ensuring our gateway's `family` string matches what Copilot Chat expects** (e.g., `gpt-5-codex` for Codex models). This drives automatic selection of the right system prompt, edit tools, verbosity, and behavioral tuning. Declaring `editTools: ['apply-patch']` is a valuable belt-and-suspenders measure. System prompt replacement is **not recommended** — Copilot Chat already sends model-specific prompts. Compaction is **already handled** by Copilot Chat's built-in LLM summarization.

---

## Question 1: Does `editTools` Actually Work?

### Finding: **Yes — it controls edit tool selection via the Copilot Chat extension's `EditToolLearningService`.**

#### What the API declares

The proposed API (`vscode.proposed.chatProvider.d.ts`) defines:

```typescript
readonly editTools?: string[];
// Recognized: 'find-replace', 'multi-find-replace', 'apply-patch', 'code-rewrite'
```

The doc comment states:

> "If not provided or if none of the tools are recognized, the editor will try multiple edit tools and pick the best one."

This is exposed to consuming extensions as `editToolsHint` on the `LanguageModelChat.capabilities` object (in `extHostLanguageModels.ts`).

#### What VS Code core does with it

In VS Code core (`microsoft/vscode`), `editTools` has three consumption points:

| File                       | Usage                                                |
| -------------------------- | ---------------------------------------------------- |
| `extHostLanguageModels.ts` | Maps `editTools` → `editToolsHint` on the API object |
| `chatModelsWidget.ts`      | Renders badge labels in the model management UI      |
| `chatModelsViewModel.ts`   | Filters/searches models by capability string         |

The actual tool selection logic lives in `microsoft/vscode-copilot-chat`, the companion extension (see below).

#### The actual edit tools

VS Code core registers a base `EditTool` in `src/vs/workbench/contrib/chat/common/tools/builtinTools/tools.ts`. However, the Copilot Chat extension registers **multiple** edit tools:

- `EditFile` (code-rewrite) — a general tool where the model provides replacement code
- `ReplaceString` (find-replace) — find and replace text in a document
- `MultiReplaceString` (multi-find-replace) — find and replace multiple snippets across documents
- `ApplyPatch` (apply-patch) — a file-oriented diff format used by OpenAI models

The `EditToolLearningService` in `vscode-copilot-chat` selects which of these tools to make available to a given model, based on:

1. Explicit BYOK provider hints (our `editTools` capability)
2. Hardcoded family preferences (GPT→ApplyPatch, Sonnet→ReplaceString)
3. A learning state machine that tracks success/failure rates over a rolling window

#### CORRECTION: It DOES Work — But in `vscode-copilot-chat`, Not VS Code Core

**The initial analysis was wrong.** The tool selection logic lives in the **Copilot Chat extension** (`microsoft/vscode-copilot-chat`), not in VS Code core. This is why searching VS Code's source found nothing — the consumption happens in the companion extension.

Key evidence from `vscode-copilot-chat`:

1. **`EditToolLearningService`** (`src/extension/tools/common/editToolLearningService.ts`) — A sophisticated learning system that tracks edit tool success/failure rates per model and selects the best tool. It has:
   - Hardcoded preferences: GPT/OpenAI → `ApplyPatch`; Sonnet → `ReplaceString` + `MultiReplaceString`
   - A learning state machine with rolling success windows for unknown models
   - Support for BYOK provider hints via `endpoint.supportedEditTools`

2. **`agentIntent.ts`** (`src/extension/intents/node/agentIntent.ts`) — The actual tool selection:

   ```typescript
   const learned = editToolLearningService.getPreferredEndpointEditTool(model);
   if (learned) {
     // a learning-enabled (BYOK) model
     allowTools[ToolName.EditFile] = learned.includes(ToolName.EditFile);
     allowTools[ToolName.ReplaceString] = learned.includes(
       ToolName.ReplaceString,
     );
     allowTools[ToolName.MultiReplaceString] = learned.includes(
       ToolName.MultiReplaceString,
     );
     allowTools[ToolName.ApplyPatch] = learned.includes(ToolName.ApplyPatch);
   }
   ```

3. **BYOK configuration** (`src/extension/byok/vscode-node/customOAIProvider.ts`) — Custom OAI models can explicitly set `editTools?: EndpointEditToolName[]` in their config.

4. **`getPreferredEndpointEditTool()`** priority order:
   1. Check `endpoint.supportedEditTools` (from BYOK provider `editTools` hint) ← **This is where our `editTools` declaration lands**
   2. Check hardcoded family preferences (GPT→ApplyPatch, Sonnet→ReplaceString)
   3. Fall back to learning state machine

5. **PR #268506 context** (connor4312, Sep 2025):

   > "For BYOK providers that can provide a curated set of models (e.g. Cerebras) we should let them tell us what edit tool is appropriate for models they give us so users have a good experience from request 0."
   > "My bet is GPT keeps apply_patch and everyone else normalizes to replace_string, or goes to apply_patch since it's more expressive"

6. **Changelog v0.32** (Oct 2025): "Improved edit tools for bring-your-own-key models" — explicitly mentions enhanced BYOK tool selection and the learning mechanism.

#### Implication for the Gateway

Declaring `editTools: ['apply-patch']` in our capabilities **WILL**:

- ✅ Show badges in the model management UI
- ✅ Allow search/filter by capability
- ✅ Be exposed via `editToolsHint` → consumed by `EditToolLearningService`
- ✅ **Cause the Copilot Chat extension to provide `apply_patch` as the edit tool** for our models from request 0 (no learning phase needed)
- ✅ Override the default learning behavior with our explicit preference

**Recommendation**: Declare `editTools: ['apply-patch']` for Codex 5.x / GPT models. This is a high-impact, low-effort change that directly controls which edit tool the model receives.

---

## Question 2: Can We Replace the System Prompt?

### Finding: **Technically yes, but the system prompt is already model-specific — Copilot Chat selects per-model prompts before they reach us.**

#### How system prompts flow

1. **Copilot Chat's `PromptRegistry`** selects a model-specific system prompt based on the model family
2. The prompt is sent as the **first message with `role=3`** (the proposed System role)
3. `extractSystemPrompt()` in `provider/system-prompt.ts` detects role=3 and extracts the text
4. `translateRequest()` in `provider/request-builder.ts` sets it as the `instructions` field
5. `executeOpenResponsesChat()` in `provider/openresponses-chat.ts` passes `instructions` to the OpenResponses `CreateResponseBody`

Since we are the `LanguageModelChatProvider`, we are the **last stop** before the request hits the API. We can:

- Pass the system prompt through verbatim (current behavior)
- Replace it entirely with a Codex-optimized prompt
- Augment it (prepend/append Codex-specific instructions)
- Conditionally modify it based on the model being used

#### CRITICAL FINDING: Copilot Chat Already Has Model-Specific Prompts

The `vscode-copilot-chat` extension has a sophisticated `PromptRegistry` system that selects different system prompts per model family. Each resolver implements `IAgentPrompt` with `resolveSystemPrompt()` and `resolveReminderInstructions()`:

| Resolver                      | `familyPrefixes`                          | System Prompt Class                                          |
| ----------------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| `DefaultOpenAIPromptResolver` | `['gpt', 'o4-mini', 'o3-mini', 'OpenAI']` | `DefaultAgentPrompt`                                         |
| `Gpt52PromptResolver`         | (matches GPT-5.2 family)                  | `HiddenModelBPrompt` — includes Codex-specific instructions  |
| `AnthropicPromptResolver`     | `['claude', 'Anthropic']`                 | `DefaultAnthropicAgentPrompt`                                |
| `GeminiPromptResolver`        | `['gemini']`                              | `DefaultGeminiAgentPrompt` / `HiddenModelFGeminiAgentPrompt` |
| `ZaiPromptResolver`           | `[]` (matches GLM 4.6/4.7 by name)        | `DefaultZaiAgentPrompt`                                      |
| `VSCModelPromptResolverA/B`   | `['vscModelA']` / `['vscModelB']`         | `VSCModelPromptA` / `VSCModelPromptB`                        |

**Key insight**: The GPT-5.2 prompt (`HiddenModelBPrompt`) already includes Codex-aligned instructions:

- "Do not waste tokens by re-reading files after calling `apply_patch`"
- "Use `git log` and `git blame` or appropriate tools to search the history"
- "Keep changes consistent with the style of the existing codebase. Changes should be minimal and focused"
- High-risk self-check instructions
- Uncertainty handling guidance

Each prompt also includes **model-specific editing instructions** — the system prompt tells the model which edit tool to prefer based on what tools are available (e.g., `apply_patch` instructions for GPT models, `replace_string` instructions for Anthropic/Gemini).

#### What this means for system prompt replacement

**Replacing the system prompt would override Copilot Chat's carefully tuned per-model prompts.** The system prompt that arrives at our gateway is NOT a generic one — it's already been selected specifically for the model family. Replacing it would:

- ❌ Lose model-specific editing instructions that match the `editTools` selection
- ❌ Lose model-specific behavioral tuning (verbosity, parallel tool use, etc.)
- ❌ Lose reminder instructions that reinforce editing patterns
- ❌ Create a maintenance burden to track changes across multiple model-specific prompts

#### Architecture

```
Copilot Chat PromptRegistry
    │ selects model-specific prompt (GPT-5.2, Claude, Gemini, etc.)
    │ renders via prompt-tsx with available tools, workspace context
    ▼
VS Code Copilot
    │ sends messages with role=3 system prompt (already model-specific)
    ▼
extractSystemPrompt()          ← intercept point 1
    │ returns system prompt string
    ▼
translateRequest()             ← intercept point 2
    │ sets instructions field
    ▼
executeOpenResponsesChat()     ← intercept point 3
    │ builds CreateResponseBody
    ▼
OpenResponses API
```

The cleanest intercept point is **point 2** (`translateRequest`), where the system prompt is already extracted and we know the model identity. However, given the model-specific prompt system, **augmentation is strongly preferred over replacement**.

---

## Question 3: Risks of Replacing the System Prompt

### Finding: **Moderate risk. VS Code's system prompt contains critical operational context.**

#### What VS Code's system prompt contains

VS Code Copilot's system prompt (sent as role=3) typically includes:

- **Tool descriptions and usage instructions** — how to use `replace_string_in_file`, `run_in_terminal`, `read_file`, etc.
- **Formatting guidelines** — Markdown, file linkification rules, KaTeX math
- **Safety/content policies** — Microsoft content policy enforcement
- **Context about the workspace** — OS, open files, workspace structure
- **Behavioral instructions** — when to use tools vs answer directly, when to ask for clarification

#### Risk matrix

| Risk                                | Severity   | Mitigation                                                                                          |
| ----------------------------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| Model loses tool usage instructions | **High**   | VS Code sends tool schemas separately via `options.tools`; instructions are supplementary           |
| Model ignores safety guidelines     | **Medium** | Codex prompt can include equivalent safety instructions                                             |
| Model formats output incorrectly    | **Medium** | Formatting rules can be preserved in augmented prompt                                               |
| Workspace context lost              | **Low**    | Context is also provided via tool results and message history                                       |
| Breaking future VS Code updates     | **Medium** | System prompt content changes without notice; hardcoded assumptions about its structure are fragile |

#### Key insight: Tool schemas vs. tool instructions

VS Code sends tool definitions (name, description, inputSchema) via `options.tools` — these are translated to `FunctionToolParam[]` in `translateRequest()` and sent alongside `instructions`. The system prompt provides **supplementary guidance** on how to use them, but the actual tool schemas are independent.

This means replacing the system prompt does **not** remove tool definitions from the request. The model still receives the tool schemas. What it loses is the opinionated guidance on _when_ and _how_ to use them.

#### Revised Recommendation

**Augmentation over replacement — and even augmentation should be minimal.** Given that Copilot Chat already has model-specific prompts:

1. **Do NOT replace** the system prompt — it's already model-specific and tuned
2. **Augment sparingly** — only append instructions that Copilot Chat's prompts genuinely lack (e.g., OpenResponses-specific behavior, custom tool guidance)
3. **Focus on `editTools` declaration** — this is the correct lever for controlling edit tool selection, not system prompt manipulation
4. **Monitor prompt evolution** — as Copilot Chat adds more model-specific prompts (they already have GPT-5, GPT-5.2, and Codex-specific ones), our augmentations may become redundant

#### When augmentation IS appropriate

There are still valid cases for appending to the system prompt:

- **OpenResponses-specific instructions** — if our backend has different capabilities than the standard OpenAI API
- **Custom tool guidance** — if we register additional tools beyond what Copilot Chat expects
- **Workspace-specific context** — if we have information about the user's setup that Copilot Chat doesn't

#### Mitigation: Agent-Assisted Prompt Sync Process

If we do augment the system prompt, the drift risk can be mitigated with a regular review process:

1. **Capture**: Periodically log/extract the current VS Code system prompt (it arrives as role=3)
2. **Diff**: Compare against our last-reviewed version to identify changes
3. **Apply**: An agent-assisted review checks whether our augmentations are still needed or have been superseded by Copilot Chat's own prompt updates
4. **Automate the cadence**: A GitHub workflow can alert when it's been >1 week since the last prompt review

---

## Question 4: Does OpenResponses Support Compaction?

### Finding: **No — but Copilot Chat already has its own built-in conversation summarization, making this less critical than initially thought.**

#### OpenResponses: No compaction endpoint

The OpenResponses client's OpenAPI spec (`packages/openresponses-client/openapi.json`, version 2.3.0) defines exactly **one path**:

```
/responses  (POST)
```

There is no `/responses/compact`, `/responses/{id}/compact`, or any compaction-related schema.

#### CRITICAL FINDING: Copilot Chat Has Built-In Summarization

The `vscode-copilot-chat` extension has an extensive conversation summarization system that handles context window management independently of any backend compaction:

1. **`SummarizedConversationHistory`** (`src/extension/conversation/common/summarizedConversationHistory.tsx`) — The main summarization system that triggers when the conversation exceeds the token budget.

2. **`ConversationHistorySummarizer`** — Makes LLM calls to summarize conversation history when the context window is exceeded. Falls back to `SimpleSummarizedHistory` if the main summarization fails.

3. **`ChatSummarizerProvider`** — Implements `vscode.ChatSummarizer`, providing summarization as a VS Code API service.

4. **`AgentIntentInvocation.buildPrompt()`** — Triggers summarization when token usage exceeds a threshold during prompt building.

5. **Responses API truncation** — `agentIntent.ts` has:

   ```typescript
   const useTruncation =
     this.endpoint.apiType === "responses" &&
     this.configurationService.getConfig(
       ConfigKey.Advanced.UseResponsesApiTruncation,
     );
   ```

   This suggests the Responses API's built-in truncation is already being used as an alternative to compaction.

6. **Anthropic context editing** — For Claude models, `src/platform/networking/common/anthropic.ts` has full `ContextManagement` types with triggers, keeps, and edits (`clear_tool_uses`, `clear_thinking`). This is Anthropic's equivalent of compaction.

#### What this means

| Compaction approach                  | Status                            | Who handles it           |
| ------------------------------------ | --------------------------------- | ------------------------ |
| OpenAI `/responses/compact`          | ❌ Not available in OpenResponses | Would need upstream work |
| Copilot Chat LLM-based summarization | ✅ Already working                | Copilot Chat extension   |
| Responses API `truncation` parameter | ✅ Available (behind config flag) | Copilot Chat + backend   |
| Anthropic context editing            | ✅ Available for Claude models    | Copilot Chat extension   |

**The compaction gap is much smaller than initially assessed.** Copilot Chat already handles context window management through its own summarization system. The missing `/responses/compact` endpoint is primarily a concern for:

- Scenarios where Copilot Chat's summarization is insufficient
- Direct API usage outside of VS Code (e.g., CLI tools, other editors)
- Cases where OpenAI's compaction would produce better results than LLM-based summarization

#### Remaining gap

The Codex prompting guide's compaction is specifically designed for the Codex model family and may produce better results than generic LLM summarization. If OpenResponses adds `/responses/compact`, we should:

1. Detect when the backend supports compaction
2. Signal this to Copilot Chat (possibly via a capability flag)
3. Allow Copilot Chat to prefer backend compaction over its own summarization

This is now a **nice-to-have optimization** rather than a **blocking gap**.

---

## Gap Analysis Summary

| Codex Recommendation                 | Current State                                      | Effort                          | Impact                                                         |
| ------------------------------------ | -------------------------------------------------- | ------------------------------- | -------------------------------------------------------------- |
| Declare `editTools: ['apply-patch']` | Not declared in `models.ts` capabilities           | Trivial (1 line)                | **High** (controls tool selection via EditToolLearningService) |
| Use `apply_patch` tool format        | VS Code provides its own edit tools                | N/A (VS Code-controlled)        | N/A                                                            |
| Custom system prompt                 | **Not recommended** — already model-specific       | N/A                             | **Negative** (would override tuned prompts)                    |
| System prompt augmentation           | Possible but should be minimal                     | Low                             | Low-Medium                                                     |
| Parallel tool calling                | Already supported by tool schema passthrough       | None needed                     | N/A                                                            |
| Compaction                           | **Already handled** by Copilot Chat summarization  | None needed (optimization only) | Low (already mitigated)                                        |
| Model-specific behavior              | **Already handled** by Copilot Chat PromptRegistry | None needed                     | N/A                                                            |
| Model family string (`family`)       | Must match Copilot Chat's expectations             | Low (verify alignment)          | **High** (drives all model-specific behavior)                  |

---

## Key Architectural Insight

**The most important thing our gateway can do is correctly declare model metadata.** The Copilot Chat extension has extensive model-specific logic keyed on the `family` string:

- `isGpt5PlusFamily()` — checks `family.startsWith('gpt-5')` → enables `apply_patch` exclusively, simplified patch instructions
- `isGptCodexFamily()` — checks `family.startsWith('gpt-') && family.includes('-codex')` → Codex-specific behavior
- `isGpt51Family()` — checks `family.startsWith('gpt-5.1')` → low verbosity mode
- `modelSupportsApplyPatch()` — checks `family.startsWith('gpt')` (excluding gpt-4o) → enables apply_patch tool
- `modelCanUseApplyPatchExclusively()` — checks `isGpt5PlusFamily()` → disables EditFile, only provides apply_patch

**If our gateway sets `family` correctly (e.g., `'gpt-5-codex'` for Codex models), Copilot Chat will automatically:**

- Select the right system prompt (GPT-5.2 / Codex-specific)
- Enable `apply_patch` as the exclusive edit tool
- Use simplified patch instructions
- Set appropriate verbosity
- Enable parallel tool calling guidance

This means the `editTools` declaration is a **belt-and-suspenders** measure — the `family` string alone drives most of the behavior. But `editTools` is still valuable as an explicit override for the `EditToolLearningService`.

---

## Actionable Items

### Quick Wins (High Impact)

1. **Verify `family` string alignment** — Ensure our gateway's model `family` values match what Copilot Chat expects. For Codex models, the family should match `isGptCodexFamily()` (starts with `gpt-` and contains `-codex`). For GPT-5 models, it should match `isGpt5PlusFamily()` (starts with `gpt-5`). **This is the single highest-impact item.**

2. **Add `editTools` to capabilities** in `models.ts` `transformToVSCodeModels()` — for GPT/Codex models, set `editTools: ['apply-patch']`; for Claude models, set `editTools: ['find-replace', 'multi-find-replace']`. This provides an explicit hint to the `EditToolLearningService`.

3. **Log editToolsHint** in the provider to confirm tool selection is working as expected.

### Medium Term

4. **Minimal system prompt augmentation** — only if we identify specific gaps in Copilot Chat's model-specific prompts for our use case (e.g., OpenResponses-specific behavior).

5. **Model capability mapping** — ensure our backend's model capability responses include all fields that Copilot Chat checks (tool calling, vision, thinking, etc.).

### Long Term (Optimization Only)

6. **Compaction support** — if OpenResponses adds `/responses/compact`, signal this capability so Copilot Chat can prefer it over LLM-based summarization. This is an optimization, not a blocker.

---

## Appendix: What We Learned from `vscode-copilot-chat`

The initial analysis searched only `microsoft/vscode` (VS Code core) and missed critical logic in `microsoft/vscode-copilot-chat` (the Copilot Chat extension). This led to several incorrect conclusions that were corrected:

| Initial Finding                        | Corrected Finding                                                            | Source                                                |
| -------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| `editTools` is UI-only                 | `editTools` controls tool selection via `EditToolLearningService`            | `editToolLearningService.ts`, `agentIntent.ts`        |
| System prompt is generic               | System prompt is model-specific via `PromptRegistry`                         | `agentPrompt.ts`, `gpt52Prompt.tsx`, etc.             |
| No compaction exists                   | Copilot Chat has built-in LLM summarization + Responses API truncation       | `summarizedConversationHistory.tsx`, `agentIntent.ts` |
| We need to add model-specific behavior | Copilot Chat already has per-model prompts, tool selection, and capabilities | `chatModelCapabilities.ts`                            |

**Lesson**: When researching VS Code extension capabilities, always search both `microsoft/vscode` AND `microsoft/vscode-copilot-chat`. The Copilot Chat extension contains the majority of the AI-specific logic.
