<script lang="ts">
  /**
   * Horizontal list of tags/badges.
   * Used for toolsUsed, subagentIds, etc.
   */

  interface Props {
    items: string[];
    label?: string;
  }

  let { items, label }: Props = $props();
</script>

{#if items.length > 0}
  <div class="tag-list">
    {#if label}
      <span class="tag-label">{label}</span>
    {/if}
    <div class="tags">
      {#each items as item}
        <span class="tag">{item}</span>
      {/each}
    </div>
  </div>
{/if}

<style>
  .tag-list {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 3px 0;
  }

  .tag-label {
    color: var(--vscode-descriptionForeground);
    min-width: 120px;
    flex-shrink: 0;
    font-size: 0.9em;
  }

  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .tag {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 10px;
    font-size: 0.85em;
    font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
</style>
