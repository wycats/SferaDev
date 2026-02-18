<script lang="ts">
  /**
   * Renders a "not found" message when the inspector URI cannot be resolved.
   */

  import type { InspectorNotFound } from "../../shared/inspector-data.js";

  interface Props {
    data: InspectorNotFound;
  }

  let { data }: Props = $props();
</script>

<div class="not-found">
  <div class="icon">?</div>
  <h2>{data.title}</h2>
  <p>{data.message}</p>
</div>

<style>
  .not-found {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 200px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
  }

  .icon {
    font-size: 3em;
    margin-bottom: 12px;
    opacity: 0.5;
  }

  .not-found h2 {
    font-size: 1.2em;
    margin: 0 0 8px 0;
    color: var(--vscode-foreground);
  }

  .not-found p {
    margin: 0;
    font-size: 0.95em;
  }
</style>
