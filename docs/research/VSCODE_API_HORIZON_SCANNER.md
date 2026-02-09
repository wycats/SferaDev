# VS Code API Horizon Scanner: Purpose & Goals

## Why This Exists

The Vercel AI Gateway VS Code extension implements proposed VS Code APIs — APIs that can change or disappear without notice. Our ability to plan feature work, prioritize investments, and avoid dead ends depends on understanding _when_ those APIs will stabilize and _how_ they're likely to evolve.

Before this tool, answering "When will `chatPromptFiles` land?" required a manual, multi-hour investigation: reading `.d.ts` files, searching GitHub issues, cross-referencing Copilot Chat's `package.json`, and synthesizing signals from milestone labels, `TODO@API` comments, and PR activity. That analysis was accurate but ephemeral — it lived in a conversation and couldn't be repeated.

The API Horizon Scanner automates that investigation into a repeatable, scriptable process.

## The Problem It Solves

### 1. Proposed API Dependency Risk

We depend on APIs like `chatPromptFiles` (custom agent providers) and `chatParticipantAdditions` (rich response parts, tool invocation, token reporting). These are _proposed_ — they require `enabledApiProposals` in our `package.json` and can break on any VS Code release.

The risk isn't theoretical. `chatParticipantAdditions` is on version `@3`, meaning it's been through at least three breaking changes. Planning feature work on top of volatile APIs without understanding their trajectory is building on sand.

### 2. Planning Horizon Blindness

When deciding what to build next, we need to weigh:

- **Should we invest in feature X that depends on proposed API Y?** If Y is weeks from stabilization, yes. If Y is months out and still has `TODO@API` comments, maybe not yet.
- **Should we build an abstraction layer over Y?** If Y's shape is still changing (`@3+`), an abstraction helps. If Y is nearly final (`api-finalization` label), the abstraction is wasted effort.
- **Should we track Y's grab-bag file or the individual interfaces within it?** Large files like `chatParticipantAdditions` (~1,069 lines, 46 interfaces) don't stabilize as a unit — individual pieces get extracted.

Without an automated way to assess these, every planning session starts with "but what's the status of...?" followed by ad-hoc research.

### 3. Signal Scatter

The information needed to assess an API's trajectory is scattered across:

- **162 `.d.ts` files** in the VS Code repo (`vscode.proposed.*.d.ts`)
- **GitHub issues** with `api-proposal` and `api-finalization` labels
- **`enabledApiProposals`** arrays in consumer extension `package.json` files
- **Milestone assignments** on GitHub issues
- **`TODO@API` comments** in the proposal files themselves

No single source gives you the picture. The scanner cross-references all of them.

## What the Scanner Does

Given the three data sources (proposal files, GitHub issues, consumer extensions), the scanner:

1. **Parses every `vscode.proposed.*.d.ts` file** — extracts name, version, interface/class/enum counts, `TODO@API` comments, and exported symbols.
2. **Fetches GitHub issues** with `api-proposal` and `api-finalization` labels (2 API calls total), then matches them to proposals using multiple heuristics (camelCase name, kebab-case variant, label references).
3. **Parses `enabledApiProposals`** from known consumer extensions (currently: Copilot Chat) to see which proposals are actively used and at what version pin.
4. **Computes a readiness score (0–100)** for each proposal based on weighted signals:
   - `api-finalization` label (strong positive)
   - Milestone assignment to current/next month (strong positive)
   - Multiple first-party consumers (moderate positive)
   - High version churn (negative)
   - `TODO@API` comments (negative)
   - Grab-bag file structure (negative)
5. **Classifies each proposal** into a horizon bucket: Near-term, Mid-term, Long-term, or Indefinite.
6. **Outputs** as either a formatted ASCII dashboard or structured JSON.

### Usage

```bash
# Full scan with GitHub data
node scripts/vscode-api-horizon.ts

# Offline mode (no GitHub API calls)
node scripts/vscode-api-horizon.ts --no-github

# Filter to chat-related proposals
node scripts/vscode-api-horizon.ts --filter chat

# JSON output for programmatic consumption
node scripts/vscode-api-horizon.ts --json

# Custom paths
node scripts/vscode-api-horizon.ts \
  --vscode-path .reference/vscode \
  --consumers .reference/vscode-copilot-chat/package.json
```

## Design Decisions

### Bulk Fetch + Local Matching (Not Per-Proposal Queries)

Early iterations queried GitHub per-proposal, which was slow and hit rate limits. The current design fetches all `api-proposal` issues and all `api-finalization` issues in bulk (2 API calls), then matches them to proposals locally.

### The Issue-to-Proposal Matching Problem (Solved)

The first version of the scanner tried to match GitHub issues to proposals by transforming the proposal file name (camelCase, kebab-case, space-separated) and grepping issue _titles_. This fundamentally didn't work because **issue titles describe feature intent, not technical identifiers**:

- `chatContextProvider` → issue title is "Chat: Support contributable chat context resources" (no match)
- `extensionAffinity` → issue title is "Allow extensions to declare their runtime affinity towards other extensions" (no match)
- `chatParticipantAdditions` → issue title is "Allow extensions to contribute custom widgets to chat responses" (no match)

In a February 2026 test, the title-matching scanner found only **2 of 7** proposals milestoned for that month.

### The Git-Log Approach (Current Design)

The fix avoids text matching entirely. Since we have the VS Code repo locally as a git clone, we can use the commit history as a structural link:

```
proposal .d.ts file
  → git log (local, free, instant)
    → PR numbers from commit messages (e.g., "Add X (#292295)")
      → PR metadata via GitHub API (carries milestone directly)
```

This works because:

- Every VS Code commit message includes the PR number in `(#NNNNN)` format
- PRs carry their own milestone (e.g., "February 2026"), independent of any tracking issue
- The proposal file path _is_ the identity — no matching heuristic can break it
- The git log is local (zero API cost); only the PR metadata lookup requires API calls

**Rate limit management**: Only proposals with recent git activity (commits in last 30 days) get their PRs checked via API. In February 2026, that was 19 of 162 proposals — well within the unauthenticated 60/hr limit. Proposals with no recent commits don't have meaningful near-term milestone signals anyway.

**What about `api-finalization`?** That label only exists on _issues_, never on PRs. We keep a single bulk fetch of `api-finalization` issues (~21 issues, 1 API call) and match those to proposals using title heuristics. This works well for finalization issues because they tend to be specifically titled (e.g., "Finalize textDocumentChangeReason API"). The finalization signal is too important to drop (+30 points in the readiness score).

**Requirement**: The `.reference/vscode` directory must be a full git clone (not a tarball or shallow clone). The script will error with a clear message if `git log` fails, telling the user to `git clone`.

### Readiness Score as Heuristic, Not Oracle

The 0–100 score is a _synthesis aid_, not a prediction. It encodes the same signals a human would check, weighted by reliability. The current weights in the script are:

| Signal                        | Weight | Rationale                      |
| ----------------------------- | ------ | ------------------------------ |
| `api-finalization` label      | +30    | Strongest lifecycle signal     |
| Milestoned current/next month | +15    | Active work commitment         |
| Any consumer                  | +5     | Being exercised in production  |
| Multiple consumers            | +5     | Broader stabilization pressure |
| Recent activity (< 30 days)   | +5     | Active development             |
| Small file (< 50 lines)       | +5     | Simple, focused scope          |
| Version churn (`@3+`)         | −10    | Ongoing breaking changes       |
| `TODO@API` comments           | −3 per | Unresolved design questions    |
| Grab-bag file (>15 exports)   | −15    | Won't stabilize as a unit      |
| Large file (> 500 lines)      | −5     | Complex surface area           |

Baseline is 50. A score above 60 means "probably worth building on now." Below 20 means "watch but don't depend."

### Offline Mode as First-Class

The `--no-github` flag makes the scanner usable without network access or a GitHub token. The local analysis (proposal files + consumer data) still produces useful output — you lose milestone and label signals but retain structural analysis, version tracking, and consumer adoption data.

## Where It Should Go Next

### Near-Term Improvements

1. **Diff against stable `vscode.d.ts`**: Detect when interfaces have already migrated from proposed to stable. This catches partial stabilization — e.g., when `ChatResponsePart` graduated but `ChatResponseQuestionCarouselPart` didn't.

2. **Historical tracking**: Store scan results over time (one JSON snapshot per scan) and show trends. "This proposal's score increased from 30 → 75 over the last 3 scans" is more useful than a single point-in-time score.

3. **Multiple consumer extensions**: Scan more than just Copilot Chat. Other first-party extensions (GitHub Pull Requests, Remote SSH) also use proposed APIs and indicate stabilization breadth.

### Medium-Term Goals

4. **Integration with planning workflow**: Output a summary that can be consumed by the exosuit planning tools — e.g., automatically flag RFCs or tasks that depend on proposed APIs and annotate them with the current horizon estimate.

5. **Watch mode**: Run on a schedule (or as a pre-commit hook), alert when a proposal's status changes meaningfully — new `api-finalization` label, new milestone assignment, version bump.

6. **Grab-bag decomposition**: For large files like `chatParticipantAdditions`, group interfaces by functional area and estimate per-group readiness. Some groups (token reporting, text edits) are far more stable than others (hook parts, question carousel).

### Long-Term Vision

7. **Community proposals**: Extend beyond first-party VS Code proposals to track third-party extension APIs that we depend on.

8. **Release note correlation**: Parse VS Code release notes to detect when proposed APIs are mentioned, correlating marketing signals with lifecycle labels.

## Companion Documents

- [VSCODE_API_HORIZON_METHODOLOGY.md](VSCODE_API_HORIZON_METHODOLOGY.md) — The manual analysis framework and signal interpretation guide, including a full case study of `chatParticipantAdditions@3`.
- [scripts/vscode-api-horizon.ts](../../scripts/vscode-api-horizon.ts) — The scanner implementation (~740 lines, zero external dependencies).

## Key Facts for Future Agents

- The scanner runs with `node scripts/vscode-api-horizon.ts` (Node.js 24+ with native TypeScript support, no bundler needed).
- It has zero npm dependencies — only `node:fs` and `node:path` imports, plus `fetch` for GitHub API.
- The `.reference/vscode` directory contains a checkout of `microsoft/vscode` with all 162 proposal files.
- The `.reference/vscode-copilot-chat` directory contains a checkout of the Copilot Chat extension.
- Both `.reference` directories are `.gitignore`d — they must exist locally but are not committed to this repo.
- GitHub API calls are unauthenticated by default (60/hr core). Set `GITHUB_TOKEN` env var or pass `--github-token` for 5,000/hr.
- The `.reference/vscode` directory must be a **full git clone** (not a tarball). The scanner uses `git log` to find PR numbers.
- The script's `--filter` flag accepts a substring match against proposal names (case-insensitive).
- Only proposals with recent git activity (last 30 days) trigger GitHub API calls for PR milestone data. This keeps API usage low (~20 calls for a typical scan).
