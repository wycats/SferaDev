<script lang="ts">
  /**
   * Renders the conversation history overview.
   *
   * Shows an activity summary table and the full entry list.
   */

  import type { InspectorHistory } from "../../shared/inspector-data.js";
  import Section from "../components/Section.svelte";
  import EntryDispatch from "./EntryDispatch.svelte";

  interface Props {
    data: InspectorHistory;
  }

  let { data }: Props = $props();
</script>

<div class="history-view">
  <h2>{data.title}</h2>

  {#if data.activitySummary.length > 0}
    <Section title="Activity Summary ({data.activitySummary.length})">
      <table class="summary-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Type</th>
            <th>Identifier</th>
            <th>Timestamp</th>
          </tr>
        </thead>
        <tbody>
          {#each data.activitySummary as row}
            <tr>
              <td class="mono">{row.index}</td>
              <td>{row.type}</td>
              <td class="mono">{row.identifier}</td>
              <td>{row.timestamp}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </Section>
  {/if}

  <Section title="Entries ({data.entries.length})">
    {#each data.entries as entry}
      <div class="entry-item">
        <EntryDispatch data={entry} />
      </div>
    {/each}
  </Section>
</div>

<style>
  .history-view h2 {
    font-size: 1.3em;
    margin: 0 0 12px 0;
    font-weight: 600;
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

  .mono {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
  }

  .entry-item {
    border-bottom: 1px solid var(--vscode-panel-border);
    padding: 8px 0;
  }

  .entry-item:last-child {
    border-bottom: none;
  }
</style>
