/**
 * Shared Shiki highlighter instance with lazy language loading.
 *
 * Uses JavaScript regex engine (no WASM) for smaller bundle size.
 * Languages are loaded on-demand via dynamic imports, which Vite
 * splits into separate chunks for efficient loading.
 *
 * Core languages (JSON, TypeScript, JavaScript, Markdown) are bundled
 * upfront since they're almost always needed. Other languages are
 * lazy-loaded when first requested.
 */

import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
// Core languages (always bundled - most common in tool results)
import langJson from "@shikijs/langs/json";
import langTypescript from "@shikijs/langs/typescript";
import langJavascript from "@shikijs/langs/javascript";
import langMarkdown from "@shikijs/langs/markdown";
import { vscodeTheme } from "./shiki-theme.js";

let highlighterPromise: Promise<HighlighterCore> | null = null;

/**
 * Map of language IDs to their dynamic import functions.
 * These are lazy-loaded when first requested.
 */
const lazyLanguages: Record<string, () => Promise<unknown>> = {
  svelte: () => import("@shikijs/langs/svelte"),
  bash: () => import("@shikijs/langs/bash"),
  shell: () => import("@shikijs/langs/bash"), // alias
  sh: () => import("@shikijs/langs/bash"), // alias
  yaml: () => import("@shikijs/langs/yaml"),
  yml: () => import("@shikijs/langs/yaml"), // alias
  toml: () => import("@shikijs/langs/toml"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  python: () => import("@shikijs/langs/python"),
  py: () => import("@shikijs/langs/python"), // alias
  rust: () => import("@shikijs/langs/rust"),
  rs: () => import("@shikijs/langs/rust"), // alias
  go: () => import("@shikijs/langs/go"),
  tsx: () => import("@shikijs/langs/tsx"),
  jsx: () => import("@shikijs/langs/jsx"),
  vue: () => import("@shikijs/langs/vue"),
  sql: () => import("@shikijs/langs/sql"),
  graphql: () => import("@shikijs/langs/graphql"),
  diff: () => import("@shikijs/langs/diff"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  java: () => import("@shikijs/langs/java"),
  ruby: () => import("@shikijs/langs/ruby"),
  rb: () => import("@shikijs/langs/ruby"), // alias
  php: () => import("@shikijs/langs/php"),
  swift: () => import("@shikijs/langs/swift"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  scala: () => import("@shikijs/langs/scala"),
};

// Track which languages are currently being loaded to avoid duplicate loads
const loadingLanguages = new Set<string>();

export async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [vscodeTheme],
      // Core languages bundled upfront
      langs: [langJson, langTypescript, langJavascript, langMarkdown],
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighterPromise;
}

/**
 * Ensure a language is loaded, loading it lazily if needed.
 * Returns the language ID to use (falls back to "text" if unavailable).
 */
export async function ensureLanguage(lang: string): Promise<string> {
  const highlighter = await getHighlighter();
  const loadedLangs = highlighter.getLoadedLanguages();

  // Already loaded
  if (loadedLangs.includes(lang)) {
    return lang;
  }

  // Check if we have a lazy loader for this language
  const loader = lazyLanguages[lang];
  if (!loader) {
    // Unknown language, fall back to text
    return "text";
  }

  // Avoid duplicate concurrent loads
  if (loadingLanguages.has(lang)) {
    // Wait a bit and check again
    await new Promise((resolve) => setTimeout(resolve, 50));
    return ensureLanguage(lang);
  }

  try {
    loadingLanguages.add(lang);
    const langModule = await loader();
    // The module default export is the language definition
    const langDef = (langModule as { default: unknown }).default;
    await highlighter.loadLanguage(
      langDef as Parameters<typeof highlighter.loadLanguage>[0],
    );
    return lang;
  } catch (e) {
    console.warn(`Failed to load language "${lang}":`, e);
    return "text";
  } finally {
    loadingLanguages.delete(lang);
  }
}
