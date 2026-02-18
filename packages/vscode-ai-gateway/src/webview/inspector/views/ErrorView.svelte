<script lang="ts">
  /**
   * Renders an error entry.
   */

  import type { InspectorError } from "../../shared/inspector-data.js";
  import KeyValue from "../components/KeyValue.svelte";
  import RawJson from "../components/RawJson.svelte";

  interface Props {
    data: InspectorError;
  }

  let { data }: Props = $props();
</script>

<div class="error-view">
  <h2 class="error-title">Error</h2>

  <div class="metadata">
    <KeyValue label="Timestamp" value={data.timestamp} />
    {#if data.turnNumber !== undefined}
      <KeyValue label="Turn" value={data.turnNumber} />
    {/if}
  </div>

  <div class="error-message">{data.message}</div>

  <RawJson data={data.raw} />
</div>

<style>
  .error-view h2.error-title {
    font-size: 1.3em;
    margin: 0 0 12px 0;
    font-weight: 600;
    color: var(--vscode-errorForeground);
  }

  .metadata {
    margin: 8px 0;
  }

  .error-message {
    padding: 8px 12px;
    background: var(
      --vscode-inputValidation-errorBackground,
      rgba(255, 0, 0, 0.1)
    );
    border: 1px solid var(--vscode-inputValidation-errorBorder, #f14c4c);
    border-radius: 4px;
    color: var(--vscode-errorForeground);
    font-family: var(--vscode-editor-font-family, monospace);
    white-space: pre-wrap;
    margin: 8px 0;
  }
</style>
