<script lang="ts">
  /**
   * Inspector webview root component.
   *
   * Dispatches structured InspectorData to the appropriate view component.
   * Subscribes to the inspector state store for reactive updates.
   */

  import { inspectorState } from "./state.js";
  import { shikiVscodeCss } from "./shiki-theme.js";

  // View components
  import AIResponseView from "./views/AIResponseView.svelte";
  import UserMessageView from "./views/UserMessageView.svelte";
  import ToolCallDetailView from "./views/ToolCallDetailView.svelte";
  import CompactionView from "./views/CompactionView.svelte";
  import ErrorView from "./views/ErrorView.svelte";
  import ToolContinuationView from "./views/ToolContinuationView.svelte";
  import TurnView from "./views/TurnView.svelte";
  import SubagentView from "./views/SubagentView.svelte";
  import ConversationView from "./views/ConversationView.svelte";
  import HistoryView from "./views/HistoryView.svelte";
  import NotFoundView from "./views/NotFoundView.svelte";

  let data = $derived($inspectorState.data);
</script>

<svelte:head>
  {@html `<style>${shikiVscodeCss}</style>`}
</svelte:head>

<main>
  {#if data === null}
    <div class="empty">
      <p>No content selected.</p>
    </div>
  {:else if data.kind === "ai-response"}
    <AIResponseView {data} />
  {:else if data.kind === "user-message"}
    <UserMessageView {data} />
  {:else if data.kind === "tool-call"}
    <ToolCallDetailView {data} />
  {:else if data.kind === "compaction"}
    <CompactionView {data} />
  {:else if data.kind === "error"}
    <ErrorView {data} />
  {:else if data.kind === "tool-continuation"}
    <ToolContinuationView {data} />
  {:else if data.kind === "turn"}
    <TurnView {data} />
  {:else if data.kind === "subagent"}
    <SubagentView {data} />
  {:else if data.kind === "conversation"}
    <ConversationView {data} />
  {:else if data.kind === "history"}
    <HistoryView {data} />
  {:else if data.kind === "not-found"}
    <NotFoundView {data} />
  {/if}
</main>

<style>
  main {
    padding: 16px;
    color: var(--vscode-foreground);
    background-color: var(--vscode-editor-background);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    line-height: 1.6;
  }

  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 200px;
    color: var(--vscode-descriptionForeground);
  }
</style>
