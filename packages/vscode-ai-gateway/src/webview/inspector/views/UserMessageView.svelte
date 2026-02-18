<script lang="ts">
  /**
   * Renders a user message entry.
   */

  import type { InspectorUserMessage } from "../../shared/inspector-data.js";
  import KeyValue from "../components/KeyValue.svelte";
  import TokenBadge from "../components/TokenBadge.svelte";
  import RawJson from "../components/RawJson.svelte";

  interface Props {
    data: InspectorUserMessage;
  }

  let { data }: Props = $props();
</script>

<div class="user-message-view">
  <h2>{data.title}</h2>

  <div class="metadata">
    <KeyValue label="Timestamp" value={data.timestamp} />
    {#if data.preview}
      <KeyValue label="Preview" value={data.preview} />
    {/if}
    {#if data.tokenContribution}
      <div class="kv-row">
        <span class="kv-label">Tokens</span>
        <TokenBadge tokens={data.tokenContribution} />
      </div>
    {/if}
    <KeyValue label="Tool continuation" value={data.isToolContinuation} />
  </div>

  <RawJson data={data.raw} />
</div>

<style>
  .user-message-view h2 {
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
