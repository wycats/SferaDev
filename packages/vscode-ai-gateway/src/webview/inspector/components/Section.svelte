<script lang="ts">
  /**
   * Collapsible section with a heading.
   * Used to organize inspector content into logical groups.
   */

  import type { Snippet } from "svelte";

  interface Props {
    title: string;
    /** Start collapsed? Default: false (expanded). */
    collapsed?: boolean;
    /** Heading level for accessibility. */
    level?: 2 | 3 | 4;
    /** Flush content to edge (no left padding). Good for code blocks. */
    flush?: boolean;
    children: Snippet;
  }

  let {
    title,
    collapsed = false,
    level = 2,
    flush = false,
    children,
  }: Props = $props();

  let isCollapsed = $state(false);

  // Sync from prop on mount (and when prop changes)
  $effect.pre(() => {
    isCollapsed = collapsed;
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="section" class:collapsed={isCollapsed}>
  <div
    class="section-header level-{level}"
    onclick={() => (isCollapsed = !isCollapsed)}
  >
    <span class="chevron">{isCollapsed ? "▶" : "▼"}</span>
    <span class="section-title">{title}</span>
  </div>
  {#if !isCollapsed}
    <div class="section-content" class:flush>
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .section {
    margin: 8px 0;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    user-select: none;
    padding: 4px 0;
  }

  .section-header:hover {
    color: var(--vscode-textLink-foreground);
  }

  .section-header.level-2 {
    font-size: 1.1em;
    font-weight: 600;
    border-bottom: 1px solid var(--vscode-panel-border);
    padding-bottom: 4px;
    margin-bottom: 4px;
  }

  .section-header.level-3 {
    font-size: 1em;
    font-weight: 600;
  }

  .section-header.level-4 {
    font-size: 0.95em;
    font-weight: 500;
  }

  .chevron {
    font-size: 0.7em;
    width: 12px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
  }

  .section-title {
    color: var(--vscode-foreground);
  }

  .section-content {
    padding-left: 18px;
  }

  .section-content.flush {
    padding-left: 0;
  }
</style>
