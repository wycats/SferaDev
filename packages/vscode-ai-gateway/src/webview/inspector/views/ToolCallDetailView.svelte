<script lang="ts">
  /**
   * Full-page view for a single tool call (when clicked from tree).
   */

  import type { InspectorToolCallView } from "../../shared/inspector-data.js";
  import KeyValue from "../components/KeyValue.svelte";
  import ToolCallCard from "../components/ToolCallCard.svelte";
  import RawJson from "../components/RawJson.svelte";

  interface Props {
    data: InspectorToolCallView;
  }

  let { data }: Props = $props();
</script>

<div class="tool-call-detail-view">
  <h2>{data.title}</h2>

  <div class="metadata">
    <KeyValue label="Call ID" value={data.callId} mono />
    <KeyValue label="Tool" value={data.toolName} mono />
    <KeyValue label="Turn" value={"#" + data.turn} />
  </div>

  <ToolCallCard toolCall={data.toolCall} />

  <RawJson data={data.raw} />
</div>

<style>
  .tool-call-detail-view h2 {
    font-size: 1.3em;
    margin: 0 0 12px 0;
    font-weight: 600;
  }

  .metadata {
    margin: 8px 0;
  }
</style>
