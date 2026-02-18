<script lang="ts">
  /**
   * Renders a full conversation overview.
   */

  import type { InspectorConversation } from "../../shared/inspector-data.js";
  import KeyValue from "../components/KeyValue.svelte";
  import TokenBadge from "../components/TokenBadge.svelte";
  import Section from "../components/Section.svelte";
  import RawJson from "../components/RawJson.svelte";
  import EntryDispatch from "./EntryDispatch.svelte";

  interface Props {
    data: InspectorConversation;
  }

  let { data }: Props = $props();
</script>

<div class="conversation-view">
  <h2>{data.title}</h2>

  <Section title="Metadata">
    <KeyValue label="ID" value={data.id} mono />
    <KeyValue label="Model" value={data.modelId} mono />
    <KeyValue label="Status" value={data.status} />
    <KeyValue label="Start time" value={data.startTime} />
    <KeyValue label="Last active" value={data.lastActiveTime} />
    <KeyValue label="Turn count" value={data.turnCount} />
    {#if data.firstMessagePreview}
      <KeyValue label="First message" value={data.firstMessagePreview} />
    {/if}
    {#if data.workspaceFolder}
      <KeyValue label="Workspace" value={data.workspaceFolder} />
    {/if}
  </Section>

  <Section title="Tokens">
    <div class="token-grid">
      <div class="token-item">
        <span class="token-label">Input</span>
        <TokenBadge tokens={data.tokens.input} />
      </div>
      <div class="token-item">
        <span class="token-label">Output</span>
        <TokenBadge tokens={data.tokens.output} />
      </div>
      <div class="token-item">
        <span class="token-label">Max Input</span>
        <TokenBadge tokens={data.tokens.maxInput} />
      </div>
      <div class="token-item">
        <span class="token-label">Total Output</span>
        <TokenBadge tokens={data.totalOutputTokens} />
      </div>
    </div>
  </Section>

  {#if data.compactionEvents.length > 0}
    <Section title="Compaction Events ({data.compactionEvents.length})">
      <table class="summary-table">
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Turn</th>
            <th>Freed</th>
            <th>Type</th>
          </tr>
        </thead>
        <tbody>
          {#each data.compactionEvents as event}
            <tr>
              <td>{event.timestamp}</td>
              <td>{event.turnNumber}</td>
              <td>{event.freedTokens.formatted}</td>
              <td>{event.type}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </Section>
  {/if}

  {#if data.subagents.length > 0}
    <Section title="Subagents ({data.subagents.length})">
      {#each data.subagents as sub}
        <div class="subagent-summary">
          <KeyValue label="Name" value={sub.name} />
          <KeyValue label="Status" value={sub.status} />
          <KeyValue label="Turns" value={sub.turnCount} />
        </div>
      {/each}
    </Section>
  {/if}

  <Section title="Activity Log ({data.entries.length})">
    {#each data.entries as entry}
      <div class="entry-item">
        <EntryDispatch data={entry} />
      </div>
    {/each}
  </Section>
</div>

<style>
  .conversation-view h2 {
    font-size: 1.3em;
    margin: 0 0 12px 0;
    font-weight: 600;
  }

  .token-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
  }

  .token-item {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .token-label {
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
    min-width: 80px;
  }

  .summary-table {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.9em;
  }

  .summary-table th,
  .summary-table td {
    border: 1px solid var(--vscode-panel-border);
    padding: 4px 8px;
    text-align: left;
  }

  .summary-table th {
    background: var(--vscode-editor-lineHighlightBackground);
    font-weight: 600;
  }

  .subagent-summary {
    padding: 6px 0;
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  .subagent-summary:last-child {
    border-bottom: none;
  }

  .entry-item {
    border-bottom: 1px solid var(--vscode-panel-border);
    padding: 8px 0;
  }

  .entry-item:last-child {
    border-bottom: none;
  }
</style>
