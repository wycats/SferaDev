<script lang="ts">
  /**
   * Renders a single tool call as a compact card.
   *
   * Design: Tool name + file location as header, arguments inline (collapsed
   * if many), result content as the card body with no extra chrome.
   */

  import type { InspectorToolCall } from "../../shared/inspector-data.js";
  import type { OpenFileMessage } from "../../shared/message-types.js";
  import { postMessage } from "../../shared/vscode-api.js";
  import ArgTree from "./ArgTree.svelte";
  import CodeBlock from "../CodeBlock.svelte";
  import MarkdownContent from "./MarkdownContent.svelte";

  interface Props {
    toolCall: InspectorToolCall;
  }

  let { toolCall }: Props = $props();

  let hasArgs = $derived(Object.keys(toolCall.args).length > 0);
  let argCount = $derived(Object.keys(toolCall.args).length);

  let locationDisplay = $derived.by(() => {
    const loc = toolCall.location;
    if (!loc) return undefined;
    let display = loc.path;
    if (loc.startLine !== undefined) {
      display += `:${loc.startLine.toString()}`;
      if (loc.endLine !== undefined && loc.endLine !== loc.startLine) {
        display += `-${loc.endLine.toString()}`;
      }
    }
    return display;
  });

  /** Split location into directory and filename for visual hierarchy */
  let locationParts = $derived.by(() => {
    if (!locationDisplay) return undefined;
    const lastSlash = locationDisplay.lastIndexOf("/");
    if (lastSlash === -1) return { dir: "", file: locationDisplay };
    return {
      dir: locationDisplay.slice(0, lastSlash + 1),
      file: locationDisplay.slice(lastSlash + 1),
    };
  });

  let resultLang = $derived(
    toolCall.result?.format === "json" ? "json" : "text",
  );

  let resultIsMarkdown = $derived(toolCall.result?.format === "markdown");

  /** Show args expanded by default only if there are few non-location args */
  let argsExpanded = $state(false);

  function openFile() {
    const loc = toolCall.location;
    if (!loc) return;

    const message: OpenFileMessage = {
      type: "open-file",
      absolutePath: loc.absolutePath,
      startLine: loc.startLine,
      endLine: loc.endLine,
    };
    postMessage(message);
  }
</script>

<div class="tool-call-card">
  <!-- Header: tool name + file location -->
  <div class="tool-call-header">
    <span class="tool-name">{toolCall.name}</span>
    {#if locationParts}
      <button class="location-link" onclick={openFile} title="Open in editor">
        <span class="location-dir">{locationParts.dir}</span><span
          class="location-file">{locationParts.file}</span
        >
      </button>
    {/if}
  </div>

  <!-- Arguments: inline toggle, not a full Section -->
  {#if hasArgs}
    <div class="args-section">
      <button
        class="args-toggle"
        onclick={() => (argsExpanded = !argsExpanded)}
      >
        <span class="toggle-chevron">{argsExpanded ? "▼" : "▶"}</span>
        <span class="args-summary">
          {argCount === 1 ? "1 argument" : `${argCount.toString()} arguments`}
        </span>
      </button>
      {#if argsExpanded}
        <div class="args-body">
          <ArgTree args={toolCall.args} />
        </div>
      {/if}
    </div>
  {/if}

  <!-- Result: the main content, no section wrapper -->
  {#if toolCall.result}
    <div class="result-body">
      {#if resultIsMarkdown}
        <MarkdownContent content={toolCall.result.content} />
      {:else}
        <CodeBlock code={toolCall.result.content} lang={resultLang} />
      {/if}
    </div>
  {:else}
    <div class="no-result">
      <em>No result captured</em>
    </div>
  {/if}
</div>

<style>
  .tool-call-card {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    margin: 6px 0;
    background: var(--vscode-editor-background);
    overflow: hidden;
  }

  .tool-call-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(
      --vscode-editor-lineHighlightBackground,
      rgba(255, 255, 255, 0.04)
    );
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  .tool-name {
    font-family: var(--vscode-editor-font-family, monospace);
    font-weight: 600;
    font-size: 0.95em;
    color: var(--vscode-symbolIcon-functionForeground, #dcdcaa);
    flex-shrink: 0;
  }

  .location-link {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em;
    color: var(--vscode-textLink-foreground);
    max-width: 400px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    margin-left: auto;
    text-align: right;
  }

  .location-link:hover {
    color: var(--vscode-textLink-activeForeground);
  }

  .location-link:hover .location-file {
    text-decoration: underline;
  }

  .location-dir {
    opacity: 0.6;
  }

  .location-file {
    color: var(--vscode-textLink-foreground);
    text-decoration: underline;
    text-decoration-style: dotted;
  }

  .location-link:hover .location-file {
    text-decoration-style: solid;
  }

  /* Arguments toggle */
  .args-section {
    padding: 0 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  .args-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: none;
    padding: 6px 0;
    cursor: pointer;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    width: 100%;
    text-align: left;
  }

  .args-toggle:hover {
    color: var(--vscode-textLink-foreground);
  }

  .toggle-chevron {
    font-size: 0.7em;
    width: 12px;
    text-align: center;
  }

  .args-summary {
    font-weight: 500;
  }

  .args-body {
    padding: 0 0 8px 18px;
  }

  /* Result body */
  .result-body {
    padding: 0;
  }

  /* Remove extra margin from code blocks inside result */
  .result-body :global(.code-block) {
    margin: 0;
    border: none;
    border-radius: 0;
  }

  /* Remove extra margin from markdown content inside result */
  .result-body :global(.markdown-content) {
    padding: 8px 12px;
  }

  .no-result {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    padding: 8px 12px;
  }
</style>
