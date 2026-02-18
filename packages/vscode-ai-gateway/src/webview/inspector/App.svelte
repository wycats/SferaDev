<script lang="ts">
  /**
   * Inspector webview root component.
   *
   * Renders inspector content with VS Code theming and syntax highlighting.
   * Subscribes to the inspector state store for reactive updates.
   * Uses Shiki with CSS variables for VS Code theme integration.
   */

  import { inspectorState } from "./state.js";
  import CodeBlock from "./CodeBlock.svelte";
  import { shikiVscodeCss } from "./shiki-theme.js";

  // Detect if content looks like JSON
  function isJson(content: string): boolean {
    const trimmed = content.trim();
    return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
  }

  // Detect language from content or title
  function detectLang(content: string, title: string): string {
    if (isJson(content)) return "json";
    if (title.toLowerCase().includes("typescript") || title.endsWith(".ts")) return "typescript";
    if (title.toLowerCase().includes("javascript") || title.endsWith(".js")) return "javascript";
    return "json"; // Default to JSON for inspector content
  }

  let lang = $derived(detectLang($inspectorState.content, $inspectorState.title));
</script>

<svelte:head>
  {@html `<style>${shikiVscodeCss}</style>`}
</svelte:head>

<main>
  <h1>{$inspectorState.title}</h1>
  <CodeBlock code={$inspectorState.content} {lang} />
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

  h1 {
    font-size: 1.4em;
    margin: 0 0 16px 0;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
</style>
