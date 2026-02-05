# Codex 5.x / VS Code Alignment Research

**Date**: 2025-07-18
**Source**: [OpenAI Codex Prompting Guide](https://cookbook.openai.com/examples/gpt-5/codex_prompting_guide)
**Goal**: Determine what, if anything, the AI Gateway extension can do to make VS Code more hospitable to Codex 5.x models.

---

## Executive Summary

The Codex 5.x prompting guide recommends specific tools (`apply_patch`, `shell_command`, `update_plan`), a structured system prompt, parallel tool-calling patterns, and conversation compaction. VS Code's current architecture aligns better than initially thought. The most actionable and highest-impact change is **declaring `editTools: ['apply-patch']`** — this is consumed by the Copilot Chat extension's `EditToolLearningService` to select which edit tool to provide to the model from request 0, skipping the learning phase entirely. Compaction is **not supported** by the OpenResponses backend and would require upstream work.

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

In VS Code core (the open-source `microsoft/vscode` repo), `editTools` has three consumption points:

| File                       | Usage                                                |
| -------------------------- | ---------------------------------------------------- |
| `extHostLanguageModels.ts` | Maps `editTools` → `editToolsHint` on the API object |
| `chatModelsWidget.ts`      | Renders badge labels in the model management UI      |
| `chatModelsViewModel.ts`   | Filters/searches models by capability string         |

The actual tool selection logic lives in `microsoft/vscode-copilot-chat`, the closed-source companion extension (see below).

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

**The initial analysis was wrong.** The tool selection logic lives in the **Copilot Chat extension** (`microsoft/vscode-copilot-chat`), not in VS Code core. This is why searching VS Code's source found nothing — the consumption happens in the closed-source companion extension.

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

### Finding: **Yes — we have full control over the `instructions` field.**

#### How system prompts flow

1. VS Code Copilot sends its system prompt as the **first message with `role=3`** (the proposed System role)
2. `extractSystemPrompt()` in `provider/system-prompt.ts` detects role=3 and extracts the text
3. `translateRequest()` in `provider/request-builder.ts` sets it as the `instructions` field
4. `executeOpenResponsesChat()` in `provider/openresponses-chat.ts` passes `instructions` to the OpenResponses `CreateResponseBody`

Since we are the `LanguageModelChatProvider`, we are the **last stop** before the request hits the API. We can:

- Pass the system prompt through verbatim (current behavior)
- Replace it entirely with a Codex-optimized prompt
- Augment it (prepend/append Codex-specific instructions)
- Conditionally modify it based on the model being used

#### Architecture

```
VS Code Copilot
    │ sends messages with role=3 system prompt
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

The cleanest intercept point is **point 2** (`translateRequest`), where the system prompt is already extracted and we know the model identity.

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

#### Recommendation

**Augmentation over replacement**. The safest approach:

1. Keep VS Code's system prompt as the base
2. Prepend/append Codex-specific instructions (patch format preference, parallel tool calling encouragement, planning behavior)
3. Make this conditional on the model family (only for Codex 5.x models)

#### Mitigation: Agent-Assisted Prompt Sync Process

If we do replace the system prompt, the drift risk can be mitigated with a regular review process:

1. **Capture**: Periodically log/extract the current VS Code system prompt (it arrives as role=3)
2. **Diff**: Compare against our last-reviewed version to identify changes
3. **Apply**: An agent-assisted review merges relevant changes into our custom prompt
4. **Automate the cadence**: A GitHub workflow can alert when it's been >1 week since the last prompt review, ensuring the process actually happens

This is a manageable maintenance burden for an actively-maintained project, and the benefit of a tailored system prompt (especially for Codex 5.x) likely outweighs the cost.

---

## Question 4: Does OpenResponses Support Compaction?

### Finding: **No. The OpenResponses API has no compaction endpoint.**

#### Evidence

The OpenResponses client's OpenAPI spec (`packages/openresponses-client/openapi.json`, version 2.3.0) defines exactly **one path**:

```
/responses  (POST)
```

There is no:

- `/responses/compact`
- `/responses/{id}/compact`
- Any compaction-related schema or parameter

#### What Codex compaction does

The Codex prompting guide describes compaction as:

- Sending the full conversation to `/responses/compact`
- Receiving a condensed version that preserves key context
- Using this to manage context window limits in long sessions

#### What we'd need

To support compaction, we would need:

1. **Upstream**: OpenResponses to implement the `/responses/compact` endpoint (or equivalent)
2. **Gateway**: Extension to detect context window pressure and trigger compaction
3. **Client** (if needed): `openresponses-client` to add compaction methods — though this may not be necessary if the gateway can call the endpoint directly

Since the compaction feature comes from OpenAI's own API, and OpenResponses aims to be compatible with the OpenAI Responses API, there's a reasonable chance they would accept a contribution implementing `/responses/compact`. This should be tracked as a potential OpenResponses extension.

This is a **backend-first** requirement — no amount of client-side work can substitute for the missing endpoint.

#### Alternative

The gateway could implement client-side summarization using a separate model call, but this would be:

- More expensive (full round-trip for summarization)
- Less accurate (no access to OpenAI's compaction model)
- Architecturally different from the Codex guide's recommendation

---

## Gap Analysis Summary

| Codex Recommendation                 | Current State                                | Effort                              | Impact                                                         |
| ------------------------------------ | -------------------------------------------- | ----------------------------------- | -------------------------------------------------------------- |
| Declare `editTools: ['apply-patch']` | Not declared in `models.ts` capabilities     | Trivial (1 line)                    | **High** (controls tool selection via EditToolLearningService) |
| Use `apply_patch` tool format        | VS Code provides its own edit tools          | N/A (VS Code-controlled)            | N/A                                                            |
| Custom system prompt                 | Possible via `translateRequest()`            | Medium                              | Medium-High                                                    |
| System prompt augmentation           | Same mechanism, lower risk                   | Low-Medium                          | Medium                                                         |
| Parallel tool calling                | Already supported by tool schema passthrough | None needed                         | N/A                                                            |
| Compaction                           | No backend support                           | High (upstream first, then gateway) | High                                                           |
| Model-specific behavior              | Can branch on model family in provider       | Medium                              | Medium                                                         |

---

## Actionable Items

### Quick Wins (High Impact)

1. **Add `editTools` to capabilities** in `models.ts` `transformToVSCodeModels()` — for GPT/Codex models, set `editTools: ['apply-patch']`; for Claude models, set `editTools: ['find-replace', 'multi-find-replace']`. This directly controls which edit tool Copilot Chat provides to the model.
2. **Log editToolsHint** in the provider to confirm tool selection is working as expected

### Medium Term

3. **System prompt augmentation** — detect Codex 5.x models and append Codex-specific instructions (patch format preference, planning behavior)
4. **Model family detection** — add model family classification to support per-model behavior

### Long Term

5. **Compaction support** — requires OpenResponses upstream work
6. **Custom tool routing** — if VS Code implements editTools-based tool selection, ensure we're declaring correctly
