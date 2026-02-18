<script lang="ts">
  /**
   * Dispatches an InspectorEntryData to the appropriate view component.
   *
   * Used by ConversationView and HistoryView to render entries inline.
   * This is a thin routing layer — each entry kind maps to its view.
   */

  import type { InspectorEntryData } from "../../shared/inspector-data.js";
  import AIResponseView from "./AIResponseView.svelte";
  import UserMessageView from "./UserMessageView.svelte";
  import ToolCallDetailView from "./ToolCallDetailView.svelte";
  import CompactionView from "./CompactionView.svelte";
  import ErrorView from "./ErrorView.svelte";
  import ToolContinuationView from "./ToolContinuationView.svelte";
  import TurnView from "./TurnView.svelte";
  import SubagentView from "./SubagentView.svelte";

  interface Props {
    data: InspectorEntryData;
  }

  let { data }: Props = $props();
</script>

{#if data.kind === "ai-response"}
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
{/if}
