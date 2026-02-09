# VS Code API Horizon Analysis: Methodology

## Purpose

This document captures a repeatable approach for assessing the stabilization timeline of VS Code proposed APIs. It was developed during an investigation of the `chatPromptFiles` and `chatParticipantAdditions` proposed APIs (February 2026).

## The Core Insight

VS Code has a well-defined API lifecycle with observable signals at each stage. By cross-referencing three data sources — **the codebase**, **GitHub issues**, and **the Copilot Chat extension** — you can build a reliable picture of what's coming and when.

## Data Sources

### 1. The VS Code Proposed API Files

**Location**: `src/vscode-dts/vscode.proposed.*.d.ts`

Each proposed API lives in a dedicated `.d.ts` file with a version comment (e.g., `// version: 3`). These files are the ground truth for what interfaces exist and how mature they are.

**What to extract**:

- File name → API proposal name (e.g., `chatPromptFiles`, `chatParticipantAdditions`)
- Version number → how many breaking changes it's been through (higher = more volatile)
- Interface/class names → what capabilities are offered
- `TODO@API` comments → unresolved design questions (red flag for stabilization)
- Size and breadth → large grab-bag files stabilize slower than focused ones

### 2. GitHub Issues with Lifecycle Labels

VS Code uses a structured label system:

| Label               | Meaning                                              |
| ------------------- | ---------------------------------------------------- |
| `api-proposal`      | Active proposed API, not yet stable                  |
| `api-finalization`  | About to graduate to stable — this is the key signal |
| `api`               | General API work                                     |
| `on-testplan`       | Being tested for a specific milestone                |
| `insiders-released` | Available in Insiders builds                         |
| `verified`          | Bug fix verified                                     |

**The critical transition**: `api-proposal` → `api-finalization` → merged into `vscode.d.ts`

**How to query**:

```
repo:microsoft/vscode is:issue label:api-proposal <api-name>
repo:microsoft/vscode is:issue label:api-finalization <api-name>
```

**Important caveat**: Issue titles often describe feature intent ("Allow extensions to contribute custom widgets to chat responses") rather than using the proposal file name (`chatParticipantAdditions`). Title-based search will miss many proposals. The issue _body_ almost always contains the literal proposal name or a link to the `.d.ts` file — so body-based matching is far more reliable for automated tools.

**Milestone assignment** is a strong signal. Each issue is milestoned to a monthly release (e.g., "February 2026"). If a proposal tracking issue is milestoned, active work is expected that month.

### 3. The Copilot Chat Extension (`enabledApiProposals`)

**Location**: `package.json` → `enabledApiProposals` array

This tells you which proposed APIs are actively consumed by first-party code. If the Copilot Chat extension uses a proposed API, it's being exercised in production-like conditions, which accelerates stabilization.

**What to extract**:

- Which proposals are in use (e.g., `chatParticipantAdditions@3`, `chatPromptFiles`)
- Version pins (the `@3` suffix) — indicates the consumer is locked to a specific version, suggesting the API is still changing

### 4. Contribution Points vs. Dynamic APIs

Some proposals have two layers:

- **Static contribution points** (declared in `package.json` `contributes` section) — these often stabilize first
- **Dynamic provider APIs** (runtime registration like `registerCustomAgentProvider`) — these stabilize later

Check which layer has already shipped stable vs. which remains proposed.

## The Analysis Framework

### Step 1: Identify the proposal file

Find the `vscode.proposed.*.d.ts` file. Note its version, size, and any `TODO@API` comments.

### Step 2: Find the tracking issue

Search GitHub for `repo:microsoft/vscode is:issue label:api-proposal <proposal-name>`. Look for:

- Milestone assignment (timing signal)
- `api-finalization` label (imminent stabilization)
- Recent comments from VS Code team members

### Step 3: Check consumer adoption

Look at `enabledApiProposals` in the Copilot Chat extension and any other first-party extensions. A proposal used by multiple first-party extensions is closer to stabilization.

### Step 4: Assess related activity

Search for recent PRs and issues that build _on top of_ the proposed API. Active feature work that depends on a proposal suggests the team considers it stable enough to build on, even if it hasn't formally graduated.

### Step 5: Check for partial stabilization

Some proposals have parts already in stable `vscode.d.ts`. Compare the proposed file's interfaces against the stable API to see what's already graduated.

## Signals Cheat Sheet

| Signal                                      | Interpretation                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| `api-finalization` label                    | Graduating within 1-2 releases                                           |
| Milestoned to current/next month            | Active work this cycle                                                   |
| Contribution points already stable          | Dynamic API likely 1-3 months behind                                     |
| Version `@1` with no TODOs                  | Relatively stable shape                                                  |
| Version `@3+` or many TODOs                 | Still evolving, further out                                              |
| Multiple first-party consumers              | Higher stabilization pressure                                            |
| No tracking issue at all                    | Possibly indefinitely proposed (internal-only)                           |
| "grab bag" file (many unrelated interfaces) | May be partially extracted; individual parts may stabilize independently |

## Automation

The `scripts/vscode-api-horizon.ts` script automates steps 1–4 of this framework. See [VSCODE_API_HORIZON_SCANNER.md](VSCODE_API_HORIZON_SCANNER.md) for its design and roadmap.

Key lesson from building it: **don't try to match GitHub issue titles to proposal file names** — issue titles describe intent in natural language, not technical identifiers. The reliable approach is structural: use `git log` on the proposal `.d.ts` file to extract PR numbers from commit messages, then fetch PR metadata from the GitHub API. PRs carry their own milestone data, so you never need to match text.

The signal chain:

```
vscode.proposed.chatContextProvider.d.ts
  → git log  →  PR #292295 (from commit message)
    → GET /repos/microsoft/vscode/pulls/292295  →  milestone: "February 2026"
```

The only GitHub Issues endpoint still needed is for `api-finalization` labels (which only exist on issues, not PRs):

```
GET /repos/microsoft/vscode/issues?labels=api-finalization&state=open&per_page=100
```

**Requirement**: The `.reference/vscode` directory must be a full git clone, not a tarball or shallow clone.

## Case Study: `chatParticipantAdditions@3` (February 2026)

This is a ~1069-line grab-bag file containing:

### Response stream parts (UI primitives)

- `ChatResponseMarkdownWithVulnerabilitiesPart` — vulnerability annotations
- `ChatResponseCodeblockUriPart` — URI-based code blocks
- `ChatResponseTextEditPart` / `ChatResponseNotebookEditPart` — streaming edits
- `ChatResponseWorkspaceEditPart` — file-level operations (create/delete/rename)
- `ChatResponseConfirmationPart` — inline user confirmations
- `ChatResponseQuestionCarouselPart` — the `askQuestions` UI (carousel with options)
- `ChatResponseCodeCitationPart` — code citation with license info
- `ChatResponseMultiDiffPart` — multi-file diff views
- `ChatResponseExternalEditPart` — tracking external tool edits
- `ChatResponseMovePart` — navigate to a location
- `ChatResponseExtensionsPart` — suggest extensions
- `ChatResponsePullRequestPart` — PR links
- `ChatResponseWarningPart` — warning messages
- `ChatResponseThinkingProgressPart` — extended thinking display
- `ChatResponseHookPart` — hook execution results

### Tool invocation infrastructure

- `ChatToolInvocationPart` — rich tool call display with type-specific data
- `ChatTerminalToolInvocationData` — terminal command execution display
- `ChatMcpToolInvocationData` — MCP tool result display
- `ChatTodoToolInvocationData` — todo list display
- `ChatSimpleToolResultData` — generic input/output display
- `ChatToolResourcesInvocationData` — file list display
- `ChatSubagentToolInvocationData` — subagent invocation display
- `ChatToolInvocationStreamData` — streaming partial tool arguments

### Token usage reporting

- `ChatResultUsage` — prompt/completion token counts
- `ChatResultPromptTokenDetail` — per-category token breakdown

### User action events (telemetry)

- Copy, Insert, Apply, Terminal, Command, Followup, Bug Report, Editor, Editing Session, Hunk actions

### Participant extensions

- `ChatParticipantCompletionItemProvider` — custom variable completions
- `ChatParticipantPauseStateEvent` — request pause/resume
- `ChatExtendedRequestHandler` — extended request handler type
- `ChatRequest` extensions — confirmation data, tool maps, mode instructions

### Tool API extensions

- `LanguageModelToolInvocationStreamOptions` — streaming tool invocation
- `LanguageModelToolStreamResult` — customized progress messages
- `LanguageModelTool.handleToolStream` — streaming tool handler
- `LanguageModelToolExtensionSource` / `LanguageModelToolMCPSource` — tool provenance

### Misc

- `lm.fileIsIgnored()` — check if a file is in `.gitignore` etc.
- `lm.onDidChangeChatRequestTools` — tool list change events
- `ChatVariableValue` / `ChatVariableLevel` — variable resolution

### Assessment

This API is too large and heterogeneous to stabilize as a unit. The likely path is that individual interfaces will be extracted into focused proposals or merged into stable `vscode.d.ts` piecemeal. The `@3` version indicates it's been through at least 3 breaking changes. No `api-finalization` tracking issue exists for the whole bag.

The most likely candidates for near-term extraction/stabilization:

- Token usage reporting (`ChatResultUsage`) — relatively simple, self-contained
- Text edit streaming — core editing functionality needed by all participants
- Tool invocation parts — widely used, relatively stable interface

The least likely for near-term stabilization:

- Question carousel — new addition (January 2026), still getting UI polish
- Hook parts — very new feature
- User action events — telemetry internals, less pressure to expose publicly
