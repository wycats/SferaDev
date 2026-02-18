<script lang="ts">
  /**
   * Collapsible raw JSON viewer for debugging.
   * Starts collapsed by default.
   */

  import Section from "./Section.svelte";
  import CodeBlock from "../CodeBlock.svelte";

  interface Props {
    data: unknown;
    title?: string;
  }

  let { data, title = "Raw JSON" }: Props = $props();

  let json = $derived(JSON.stringify(data, null, 2));
</script>

<Section {title} collapsed={true} level={3}>
  <CodeBlock code={json} lang="json" />
</Section>
