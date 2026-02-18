<script lang="ts">
  /**
   * Key-value display row for inspector metadata.
   * Renders a label and value in a compact horizontal layout.
   */

  interface Props {
    label: string;
    value?: string | number | boolean | null;
    /** If true, render value as monospace code. */
    mono?: boolean;
  }

  let { label, value, mono = false }: Props = $props();

  let displayValue = $derived(
    value === undefined || value === null
      ? "—"
      : typeof value === "boolean"
        ? value
          ? "yes"
          : "no"
        : String(value),
  );
</script>

<div class="kv-row">
  <span class="kv-label">{label}</span>
  {#if mono}
    <code class="kv-value mono">{displayValue}</code>
  {:else}
    <span class="kv-value">{displayValue}</span>
  {/if}
</div>

<style>
  .kv-row {
    display: flex;
    gap: 8px;
    padding: 3px 0;
    align-items: baseline;
    font-size: var(--vscode-font-size);
  }

  .kv-label {
    color: var(--vscode-descriptionForeground);
    min-width: 120px;
    flex-shrink: 0;
    font-size: 0.9em;
  }

  .kv-value {
    color: var(--vscode-foreground);
    word-break: break-word;
  }

  .kv-value.mono {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    background: var(--vscode-textCodeBlock-background);
    padding: 1px 4px;
    border-radius: 3px;
  }
</style>
