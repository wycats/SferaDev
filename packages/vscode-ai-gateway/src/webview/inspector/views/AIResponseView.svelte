<script lang="ts">
  /**
   * Renders an AI response entry with structured data.
   *
   * Design: Lead with the story (characterization → response → tool calls),
   * push metadata into a compact summary bar, use progressive disclosure.
   */

  import type { InspectorAIResponse } from "../../shared/inspector-data.js";
  import KeyValue from "../components/KeyValue.svelte";
  import Section from "../components/Section.svelte";
  import ToolCallCard from "../components/ToolCallCard.svelte";
  import MarkdownContent from "../components/MarkdownContent.svelte";
  import RawJson from "../components/RawJson.svelte";

  interface Props {
    data: InspectorAIResponse;
  }

  let { data }: Props = $props();

  let hasCharacterization = $derived(
    data.characterization !== undefined && data.characterization.length > 0,
  );

  let stateBadgeClass = $derived(
    data.state === "characterized"
      ? "state-characterized"
      : data.state === "streaming"
        ? "state-streaming"
        : data.state === "interrupted"
          ? "state-interrupted"
          : "state-other",
  );

  /** Compact timestamp: just time portion if today, otherwise short date+time */
  let shortTimestamp = $derived.by(() => {
    if (!data.timestamp) return "";
    try {
      const d = new Date(data.timestamp);
      const now = new Date();
      if (
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate()
      ) {
        return d.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
      }
      return d.toLocaleDateString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return data.timestamp;
    }
  });

  let hasDetails = $derived(
    data.usage !== undefined ||
      data.finishReason !== undefined ||
      data.responseId !== undefined ||
      data.characterizationError !== undefined,
  );
</script>

<div class="ai-response-view">
  <!-- Header: characterization + compact summary bar -->
  <header class="response-header">
    {#if hasCharacterization}
      <h2 class="characterization">{data.characterization}</h2>
    {:else}
      <h2 class="characterization">AI Response #{data.sequenceNumber}</h2>
    {/if}

    <div class="summary-bar">
      <span class="state-badge {stateBadgeClass}">{data.state}</span>
      {#if shortTimestamp}
        <span class="summary-item">{shortTimestamp}</span>
      {/if}
      <span
        class="summary-item mono"
        title="{data.tokenContribution.raw.toLocaleString()} tokens"
      >
        {data.tokenContribution.formatted} tokens
      </span>
      {#if hasCharacterization}
        <span class="summary-item dim">#{data.sequenceNumber}</span>
      {/if}
    </div>
  </header>

  <!-- Characterization error (rare, but important when present) -->
  {#if data.characterizationError}
    <div class="char-error">
      <span class="error-icon">&#9888;</span>
      {data.characterizationError}
    </div>
  {/if}

  <!-- Response text — the AI's words, shown immediately -->
  {#if data.responseText}
    <div class="response-text">
      <MarkdownContent content={data.responseText} />
    </div>
  {/if}

  <!-- Tool calls — the main content -->
  {#if data.toolCalls.length > 0}
    <div class="tool-calls-section">
      <div class="tool-calls-header">
        {data.toolCalls.length === 1
          ? "1 tool call"
          : `${data.toolCalls.length.toString()} tool calls`}
      </div>
      {#each data.toolCalls as toolCall}
        <ToolCallCard {toolCall} />
      {/each}
    </div>
  {/if}

  <!-- Subagents (if any) -->
  {#if data.subagentIds.length > 0}
    <div class="subagents">
      <span class="subagents-label">Subagents</span>
      {#each data.subagentIds as id}
        <span class="subagent-tag">{id}</span>
      {/each}
    </div>
  {/if}

  <!-- Details: usage breakdown, finish reason, response ID — collapsed -->
  {#if hasDetails}
    <Section title="Details" collapsed={true} level={3}>
      {#if data.usage}
        <KeyValue
          label="Input tokens"
          value={data.usage.inputTokens.toLocaleString()}
        />
        <KeyValue
          label="Output tokens"
          value={data.usage.outputTokens.toLocaleString()}
        />
      {/if}
      {#if data.finishReason}
        <KeyValue label="Finish reason" value={data.finishReason} mono />
      {/if}
      {#if data.responseId}
        <KeyValue label="Response ID" value={data.responseId} mono />
      {/if}
    </Section>
  {/if}

  <!-- Raw JSON — collapsed -->
  <RawJson data={data.raw} />
</div>

<style>
  .ai-response-view {
    padding: 0;
  }

  .response-header {
    margin-bottom: 12px;
  }

  .characterization {
    font-size: 1.3em;
    margin: 0 0 6px 0;
    font-weight: 600;
    color: var(--vscode-foreground);
    line-height: 1.3;
  }

  .summary-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .summary-item {
    font-size: 0.82em;
    color: var(--vscode-descriptionForeground);
  }

  .summary-item.mono {
    font-family: var(--vscode-editor-font-family, monospace);
  }

  .summary-item.dim {
    opacity: 0.6;
  }

  .state-badge {
    font-size: 0.75em;
    padding: 1px 8px;
    border-radius: 10px;
    font-weight: 500;
    text-transform: lowercase;
    line-height: 1.6;
  }

  .state-characterized {
    background: var(--vscode-testing-iconPassed, #388a34);
    color: #fff;
  }

  .state-streaming {
    background: var(--vscode-progressBar-background, #0e70c0);
    color: #fff;
  }

  .state-interrupted {
    background: var(--vscode-testing-iconFailed, #f14c4c);
    color: #fff;
  }

  .state-other {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }

  .char-error {
    color: var(--vscode-errorForeground);
    font-size: 0.9em;
    padding: 6px 8px;
    margin-bottom: 8px;
    background: var(
      --vscode-inputValidation-errorBackground,
      rgba(255, 0, 0, 0.1)
    );
    border-radius: 4px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .error-icon {
    font-size: 1.1em;
  }

  .response-text {
    margin: 8px 0 16px 0;
  }

  .tool-calls-section {
    margin: 12px 0;
  }

  .tool-calls-header {
    font-size: 0.85em;
    font-weight: 500;
    color: var(--vscode-descriptionForeground);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  .subagents {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    margin: 8px 0;
  }

  .subagents-label {
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    font-weight: 500;
  }

  .subagent-tag {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 10px;
    font-size: 0.82em;
    font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
</style>
