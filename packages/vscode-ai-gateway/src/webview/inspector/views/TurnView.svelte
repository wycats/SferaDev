<script lang="ts">
  /**
   * Renders a turn entry.
   */

  import type { InspectorTurn } from "../../shared/inspector-data.js";
  import KeyValue from "../components/KeyValue.svelte";
  import TokenBadge from "../components/TokenBadge.svelte";
  import TagList from "../components/TagList.svelte";
  import RawJson from "../components/RawJson.svelte";

  interface Props {
    data: InspectorTurn;
  }

  let { data }: Props = $props();
</script>

<div class="turn-view">
  <h2>{data.title}</h2>

  <div class="metadata">
    <KeyValue label="Timestamp" value={data.timestamp} />
    {#if data.characterization}
      <KeyValue label="Characterization" value={data.characterization} />
    {/if}
    <div class="kv-row">
      <span class="kv-label">Output tokens</span>
      <TokenBadge tokens={data.outputTokens} />
    </div>
    <KeyValue label="Streaming" value={data.streaming} />
  </div>

  {#if data.subagentIds.length > 0}
    <TagList items={data.subagentIds} label="Subagents" />
  {/if}

  <RawJson data={data.raw} />
</div>

<style>
  .turn-view h2 {
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
