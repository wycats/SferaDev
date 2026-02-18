<script lang="ts">
  /**
   * Renders a subagent entry.
   */

  import type { InspectorSubagentView } from "../../shared/inspector-data.js";
  import KeyValue from "../components/KeyValue.svelte";
  import Section from "../components/Section.svelte";
  import RawJson from "../components/RawJson.svelte";

  interface Props {
    data: InspectorSubagentView;
  }

  let { data }: Props = $props();

  let sub = $derived(data.subagent);
</script>

<div class="subagent-view">
  <h2>{data.title}</h2>

  <div class="metadata">
    <KeyValue label="Conversation ID" value={sub.conversationId} mono />
    <KeyValue label="Status" value={sub.status} />
    <KeyValue label="Turn count" value={sub.turnCount} />
    <KeyValue label="Input tokens" value={sub.tokens.input.toLocaleString()} />
    <KeyValue
      label="Output tokens"
      value={sub.tokens.output.toLocaleString()}
    />
  </div>

  {#if sub.children.length > 0}
    <Section title="Children ({sub.children.length})">
      {#each sub.children as child}
        <div class="child-subagent">
          <KeyValue label="Name" value={child.name} />
          <KeyValue label="Status" value={child.status} />
          <KeyValue label="Turns" value={child.turnCount} />
        </div>
      {/each}
    </Section>
  {/if}

  <RawJson data={data.raw} />
</div>

<style>
  .subagent-view h2 {
    font-size: 1.3em;
    margin: 0 0 12px 0;
    font-weight: 600;
  }

  .metadata {
    margin: 8px 0;
  }

  .child-subagent {
    padding: 6px 0;
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  .child-subagent:last-child {
    border-bottom: none;
  }
</style>
