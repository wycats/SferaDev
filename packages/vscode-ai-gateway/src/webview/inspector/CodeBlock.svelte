<script lang="ts">
  /**
   * Syntax-highlighted code block component using Shiki.
   *
   * Uses CSS variables theme to automatically follow VS Code's theme.
   * Uses JavaScript regex engine (no WASM) for smaller bundle size.
   * Includes copy-to-clipboard functionality.
   */

  import { createHighlighterCore, type HighlighterCore } from "shiki/core";
  import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
  import langJson from "@shikijs/langs/json";
  import langTypescript from "@shikijs/langs/typescript";
  import langJavascript from "@shikijs/langs/javascript";
  import { vscodeTheme } from "./shiki-theme.js";

  interface Props {
    code: string;
    lang?: string;
  }

  let { code, lang = "json" }: Props = $props();

  // Highlighted HTML state
  let highlightedHtml = $state("");
  let copied = $state(false);

  // Lazy-load highlighter (created once, reused)
  let highlighterPromise: Promise<HighlighterCore> | null = null;

  async function getHighlighter(): Promise<HighlighterCore> {
    if (!highlighterPromise) {
      highlighterPromise = createHighlighterCore({
        themes: [vscodeTheme],
        langs: [langJson, langTypescript, langJavascript],
        engine: createJavaScriptRegexEngine(),
      });
    }
    return highlighterPromise;
  }

  // Highlight code when it changes
  $effect(() => {
    const currentCode = code;
    const currentLang = lang;

    getHighlighter().then((highlighter) => {
      // Check if lang is supported, fallback to json
      const loadedLangs = highlighter.getLoadedLanguages();
      const effectiveLang = loadedLangs.includes(currentLang) ? currentLang : "json";

      highlightedHtml = highlighter.codeToHtml(currentCode, {
        lang: effectiveLang,
        theme: "vscode-variables",
      });
    });
  });

  async function copyToClipboard() {
    try {
      await navigator.clipboard.writeText(code);
      copied = true;
      setTimeout(() => {
        copied = false;
      }, 2000);
    } catch {
      // Clipboard API may not be available in all contexts
      console.warn("Failed to copy to clipboard");
    }
  }
</script>

<div class="code-block">
  <div class="code-header">
    <span class="lang-label">{lang}</span>
    <button class="copy-button" onclick={copyToClipboard} title="Copy to clipboard">
      {#if copied}
        <span class="codicon codicon-check"></span>
      {:else}
        <span class="codicon codicon-copy"></span>
      {/if}
    </button>
  </div>
  <div class="code-content">
    {#if highlightedHtml}
      {@html highlightedHtml}
    {:else}
      <pre><code>{code}</code></pre>
    {/if}
  </div>
</div>

<style>
  .code-block {
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #454545));
    border-radius: 4px;
    overflow: hidden;
    margin: 8px 0;
  }

  .code-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 8px;
    background: var(--vscode-editor-lineHighlightBackground, rgba(255, 255, 255, 0.04));
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #454545));
  }

  .lang-label {
    font-size: 11px;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    font-weight: 500;
  }

  .copy-button {
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 3px;
    color: var(--vscode-foreground);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .copy-button:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
  }

  .code-content {
    overflow-x: auto;
  }

  .code-content :global(.shiki) {
    margin: 0;
    padding: 12px;
    background: var(--vscode-editor-background) !important;
  }

  .code-content :global(pre) {
    margin: 0;
    padding: 12px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    line-height: 1.5;
  }

  .code-content :global(code) {
    font-family: inherit;
  }

  /* Codicon font (loaded from VS Code) */
  .codicon {
    font-family: codicon;
    font-size: 14px;
  }

  .codicon-copy::before {
    content: "\eb8c";
  }

  .codicon-check::before {
    content: "\eab2";
  }
</style>
