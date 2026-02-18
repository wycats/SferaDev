<script lang="ts">
  /**
   * Renders a compaction entry.
   */

  import type { InspectorCompaction } from "../../shared/inspector-data.js";
  import KeyValue from "../components/KeyValue.svelte";
  import TokenBadge from "../components/TokenBadge.svelte";
  import RawJson from "../components/RawJson.svelte";

  interface Props {
    data: InspectorCompaction;
  }

  let { data }: Props = $props();
</script>

<div class="compaction-view">
  <h2>{data.title}</h2>

  <div class="metadata">
    <KeyValue label="Timestamp" value={data.timestamp} />
    <KeyValue label="Turn" value={data.turnNumber} />
    <div class="kv-row">
      <span class="kv-label">Freed tokens</span>
      <TokenBadge tokens={data.freedTokens} />
    </div>
    <KeyValue label="Type" value={data.compactionType} mono />
    {#if data.details}
      <KeyValue label="Details" value={data.details} />
    {/if}
  </div>

  <RawJson data={data.raw} />
</div>

<style>
  .compaction-view h2 {
    font-size: 1.3em;
    margin: 0 0 12px 0;
    font-weight: 600;
  }

  .metadata {
    margin: 8px 0;
  }

  .kv-row {
    display: flex;
    gap: 8px;
    padding: 3px 0;
    align-items: baseline;
  }

  .kv-label {
    color: var(--vscode-descriptionForeground);
    min-width: 120px;
    flex-shrink: 0;
    font-size: 0.9em;
  }
</style>
