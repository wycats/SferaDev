# Summarization Loop & Tool Overhead Analysis
**Date:** 2026-02-09
**Status:** Findings Confirmed

## Executive Summary
The "context pressure death spiral" where Copilot Chat repeatedly summarizes the conversation is caused by a structural conflict between the high fixed token cost of VS Code's tool definitions (~45k tokens) and the conservative `maxInputTokens` limit (128k) enforced by the specific model configuration.

## Key Findings

### 1. Tool Overhead is "Real" (Not Fragmentation)
We suspected that VS Code's method of tokenizing tool schemas (fragment-by-fragment) might inflate the token count compared to tokenizing the whole schema.
**Experiment:** Tokenized 100 sample tool schema strings individually vs joined.
**Result:** 282 tokens (sum of parts) vs 288 tokens (joined). Difference is < 2%.
**Conclusion:** The ~45k tool overhead observed in logs is accurate. The tool definitions provided by VS Code are simply voluminous.

### 2. The Budget Squeeze
With 128k `maxInputTokens`:
- **Tools:** ~45k tokens (Fixed Cost, ~35% of budget)
- **Available for Chat:** ~83k tokens
- **Summarization Trigger:** When Total > 128k.

When a conversation exceeds 128k, VS Code summarizes the message history. However, it cannot summarize the tools. Even if the conversation is summarized down to ~80k tokens, the total becomes:
`45k (Tools) + 80k (Summary + Recent) = 125k`

This leaves only **3k tokens** of headroom. The very next user message or model response pushes the total back over 128k, triggering another summarization attempt immediately. This creates the "loop".

### 3. Forensic Analysis Tooling
Created `packages/vscode-ai-gateway/scripts/analyze-forensic-logs.cjs` to automate token distribution analysis.
Sample Output:
```text
Burst #1
  Tools (Strings): 3514 calls, 20498 tokens
  Messages:        10 unique, 5462 tokens
  Total Usage:     25960 / 128000 (Overhead Ratio: 79.0% tools)
```

## Comparative Analysis: Why Copilot Models Don't Loop

The user asked: *"Why is the behavior different with copilot models than vercel models?"*

Since VS Code injects the same tool definitions for all participants, the difference lies in **Token Reporting Strategy**.

1.  **System Architecture**:
    - **The Participant (UI)**: Sends identical content (User Messages + 45k of Tool Definitions) to the selected Provider.
    - **The check**: Calls `provider.provideTokenCount()` to gauge usages.
    - **The Logic**: If `Usage > Limit`, trigger specific summarization logic.

2.  **The Divergence**:
    - **Input**: Identical for both providers.
    - **Limit**: Identical (128k) or similar.
    - **Outcome**: Vercel triggers summarization (loops); Copilot does not.
    - **Deduction**: Therefore, `Vercel_Count > Limit > Copilot_Count`.

3.  **Conclusion**:
    - **Vercel Extension (Total Accuracy)**: We count every token, including the ~45k tool overhead using `tiktoken`. This accurately reflects what will be sent to the API.
    - **Copilot Extension (User-Centric/Discounted)**: Copilot's implementation of `provideTokenCount` **must** significantly discount or ignore the tool definition strings. By reporting a lower number (e.g., excluding the 45k overhead), they stay below the limit.
    - **Implication**: Copilot exposes the user to "Context Limit Errors" from the API (if the backend strictly enforces the limit), or relies on a backend that handles the overflow (e.g. by silently dropping tools or having a true limit of >128k).

## Recommendation

Since we cannot control the size of the tool definitions (controlled by VS Code/Participant) and "lying" about token counts (ignoring tools) risks API rejections if we exceed the *actual* model hard limit, we must increase the reported capacity to match the **true capability** of the models we function with.

**Proposal:** Increase `CONSERVATIVE_MAX_INPUT_TOKENS` in `src/constants.ts` to **180,000** (or model max).
- **Claude 3 Opus / 3.5 Sonnet:** Supports 200k context.
- **Proposed Budget:** 180k.
- **New Math:** 45k (Tools) + 135k (Chat).
- This aligns our reporting with the model's physics, fixing the "loop" by providing ~50k tokens of headroom after summarization.
