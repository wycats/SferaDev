<script lang="ts">
  /**
   * Compact token count badge.
   * Shows formatted value (e.g., "1.2k") with raw value on hover.
   */

  import type { TokenDisplay } from "../../shared/inspector-data.js";

  interface Props {
    tokens: TokenDisplay;
    label?: string;
  }

  let { tokens, label }: Props = $props();
</script>

<span class="token-badge" title="{tokens.raw.toLocaleString()} tokens">
  {#if label}
    <span class="token-label">{label}</span>
  {/if}
  <span class="token-value">{tokens.formatted}</span>
</span>

<style>
  .token-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
  }

  .token-label {
    opacity: 0.8;
  }

  .token-value {
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-foreground);
  }
</style>
