<script lang="ts">
  /**
   * Renders markdown content with Shiki syntax highlighting for code blocks.
   *
   * Used for AI response text and tool results that contain markdown.
   * Code fences get proper syntax highlighting via the shared Shiki highlighter.
   */

  import { Marked } from "marked";
  import { getHighlighter, ensureLanguage } from "../highlighter.js";

  interface Props {
    content: string;
  }

  let { content }: Props = $props();

  // Custom renderer that marks code blocks for Shiki processing
  const marked = new Marked({
    async: true,
    renderer: {
      code({ text, lang }) {
        const escapedCode = text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        return `<pre class="shiki-pending" data-lang="${lang ?? "text"}"><code>${escapedCode}</code></pre>`;
      },
    },
  });

  let renderedHtml = $state("");

  // Render markdown and apply Shiki highlighting to code blocks
  $effect(() => {
    const currentContent = content;

    (async () => {
      // First pass: render markdown
      const html = (await marked.parse(currentContent)) as string;

      // Second pass: apply Shiki to code blocks (with lazy language loading)
      const highlighter = await getHighlighter();
      const div = document.createElement("div");
      div.innerHTML = html;

      const codeBlocks = div.querySelectorAll("pre.shiki-pending");
      for (const block of codeBlocks) {
        const code = block.textContent ?? "";
        const lang = block.getAttribute("data-lang") ?? "text";
        const effectiveLang = await ensureLanguage(lang);

        const highlighted = highlighter.codeToHtml(code, {
          lang: effectiveLang,
          theme: "vscode-variables",
        });
        block.outerHTML = highlighted;
      }

      renderedHtml = div.innerHTML;
    })();
  });
</script>

<div class="markdown-content">
  {@html renderedHtml}
</div>

<style>
  .markdown-content :global(h1),
  .markdown-content :global(h2),
  .markdown-content :global(h3) {
    margin-top: 1em;
    margin-bottom: 0.5em;
    font-weight: 600;
  }

  .markdown-content :global(h2) {
    font-size: 1.2em;
    border-bottom: 1px solid var(--vscode-panel-border);
    padding-bottom: 4px;
  }

  .markdown-content :global(h3) {
    font-size: 1.1em;
  }

  .markdown-content :global(table) {
    border-collapse: collapse;
    width: 100%;
    margin: 1em 0;
  }

  .markdown-content :global(th),
  .markdown-content :global(td) {
    border: 1px solid var(--vscode-panel-border);
    padding: 8px 12px;
    text-align: left;
  }

  .markdown-content :global(th) {
    background: var(--vscode-editor-lineHighlightBackground);
    font-weight: 600;
  }

  .markdown-content :global(pre) {
    margin: 1em 0;
    border-radius: 4px;
    overflow-x: auto;
  }

  .markdown-content :global(.shiki) {
    padding: 8px;
    border-radius: 4px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    line-height: 1.5;
  }

  .markdown-content :global(code) {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
    background: var(--vscode-textCodeBlock-background);
    padding: 2px 4px;
    border-radius: 3px;
  }

  .markdown-content :global(pre code) {
    background: none;
    padding: 0;
  }

  .markdown-content :global(p) {
    margin: 0.5em 0;
  }

  .markdown-content :global(ul),
  .markdown-content :global(ol) {
    margin: 0.5em 0;
    padding-left: 1.5em;
  }
</style>
