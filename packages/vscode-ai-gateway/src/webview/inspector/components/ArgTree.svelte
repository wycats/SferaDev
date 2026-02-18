<script lang="ts">
  /**
   * Tree view for tool call arguments.
   *
   * Renders key-value pairs with special handling for:
   * - File paths: displayed as clickable links
   * - Booleans: displayed as yes/no badges
   * - Arrays: displayed as comma-separated values
   * - Objects: displayed as nested trees
   * - Long strings: truncated with expand
   */

  interface Props {
    args: Record<string, unknown>;
  }

  let { args }: Props = $props();

  function isFilePath(key: string, value: unknown): boolean {
    if (typeof value !== "string") return false;
    const pathKeys = ["filePath", "path", "file", "filename", "uri", "dirPath"];
    if (pathKeys.includes(key)) return true;
    // Heuristic: starts with / or contains common path separators
    return /^\/[a-zA-Z]/.test(value) && value.includes("/");
  }

  function formatValue(value: unknown): string {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return JSON.stringify(value);
  }

  function isSimpleValue(value: unknown): boolean {
    return (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null ||
      value === undefined
    );
  }

  const entries = $derived(Object.entries(args));
</script>

<div class="arg-tree">
  {#each entries as [key, value]}
    <div class="arg-row">
      <span class="arg-key">{key}</span>
      <span class="arg-separator">:</span>
      {#if isFilePath(key, value)}
        <span class="arg-value file-path" title={String(value)}>
          {String(value)}
        </span>
      {:else if typeof value === "boolean"}
        <span
          class="arg-value bool-badge"
          class:bool-true={value}
          class:bool-false={!value}
        >
          {value ? "true" : "false"}
        </span>
      {:else if typeof value === "number"}
        <span class="arg-value number">{value}</span>
      {:else if Array.isArray(value)}
        {#if value.length === 0}
          <span class="arg-value empty">[]</span>
        {:else if value.every((v) => isSimpleValue(v))}
          <span class="arg-value array">
            {value.map((v) => formatValue(v)).join(", ")}
          </span>
        {:else}
          <pre class="arg-value json">{JSON.stringify(value, null, 2)}</pre>
        {/if}
      {:else if typeof value === "object" && value !== null}
        <pre class="arg-value json">{JSON.stringify(value, null, 2)}</pre>
      {:else if typeof value === "string" && value.length > 200}
        <span class="arg-value long-string" title={value}>
          {value.slice(0, 200)}…
        </span>
      {:else}
        <span class="arg-value">{formatValue(value)}</span>
      {/if}
    </div>
  {/each}
</div>

<style>
  .arg-tree {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    line-height: 1.6;
  }

  .arg-row {
    display: flex;
    gap: 6px;
    align-items: baseline;
    padding: 1px 0;
  }

  .arg-key {
    color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe);
    flex-shrink: 0;
  }

  .arg-separator {
    color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
  }

  .arg-value {
    color: var(--vscode-foreground);
    word-break: break-word;
  }

  .arg-value.file-path {
    color: var(--vscode-textLink-foreground);
    text-decoration: underline;
    text-decoration-style: dotted;
    cursor: default;
  }

  .arg-value.bool-badge {
    padding: 0 6px;
    border-radius: 8px;
    font-size: 0.9em;
  }

  .arg-value.bool-true {
    background: var(--vscode-testing-iconPassed, #388a34);
    color: #fff;
  }

  .arg-value.bool-false {
    background: var(--vscode-descriptionForeground);
    color: var(--vscode-editor-background);
    opacity: 0.6;
  }

  .arg-value.number {
    color: var(--vscode-symbolIcon-numberForeground, #b5cea8);
  }

  .arg-value.empty {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }

  .arg-value.json {
    margin: 4px 0;
    padding: 8px;
    background: var(--vscode-textCodeBlock-background);
    border-radius: 4px;
    overflow-x: auto;
    white-space: pre;
    font-size: inherit;
    font-family: inherit;
  }

  .arg-value.long-string {
    color: var(--vscode-foreground);
    opacity: 0.8;
  }

  .arg-value.array {
    color: var(--vscode-foreground);
  }
</style>
