<script lang="ts">
  /**
   * Inspector webview root component.
   *
   * Renders inspector content with VS Code theming.
   * Will be enhanced with markdown rendering and interactive
   * components in the svelte-enhance phase.
   */

  interface Props {
    content: string;
    title: string;
  }

  let { content, title }: Props = $props();
</script>

<main>
  <h1>{title}</h1>
  <pre>{content}</pre>
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

  pre {
    white-space: pre-wrap;
    word-wrap: break-word;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
    background-color: var(--vscode-textCodeBlock-background);
    padding: 12px;
    border-radius: 4px;
    margin: 0;
    overflow-x: auto;
  }
</style>
