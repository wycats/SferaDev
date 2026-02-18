#!/usr/bin/env node
/**
 * Build script for the VS Code extension.
 *
 * Runs two esbuild builds:
 * 1. Extension build (Node, ESM) → out/extension.js
 * 2. Webview build (browser, IIFE, Svelte) → out/webview/main.js
 *
 * Usage:
 *   node scripts/build.mjs          # Production build (minified)
 *   node scripts/build.mjs --watch  # Development mode with watch
 */

import * as esbuild from "esbuild";
import sveltePlugin from "esbuild-svelte";

const isWatch = process.argv.includes("--watch");
const isMinify = !isWatch;

// ─────────────────────────────────────────────────────────────────────────────
// Extension build configuration
// ─────────────────────────────────────────────────────────────────────────────

/** @type {esbuild.BuildOptions} */
const extensionConfig = {
  entryPoints: ["./src/extension.ts"],
  bundle: true,
  outdir: "out",
  external: ["vscode"],
  format: "esm",
  platform: "node",
  splitting: true,
  minify: isMinify,
  sourcemap: !isMinify,
  logLevel: "info",
};

// ─────────────────────────────────────────────────────────────────────────────
// Webview build configuration
// ─────────────────────────────────────────────────────────────────────────────

/** @type {esbuild.BuildOptions} */
const webviewConfig = {
  entryPoints: ["./src/webview/inspector/main.ts"],
  bundle: true,
  outdir: "out/webview",
  format: "iife",
  platform: "browser",
  minify: isMinify,
  sourcemap: !isMinify,
  logLevel: "info",
  // Svelte-specific settings
  mainFields: ["svelte", "browser", "module", "main"],
  conditions: ["svelte", "browser"],
  plugins: [
    sveltePlugin({
      compilerOptions: {
        // Inject CSS into JS (simpler CSP, single file)
        css: "injected",
      },
    }),
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Build execution
// ─────────────────────────────────────────────────────────────────────────────

async function build() {
  if (isWatch) {
    // Watch mode: create contexts and watch both
    const [extensionCtx, webviewCtx] = await Promise.all([
      esbuild.context(extensionConfig),
      esbuild.context(webviewConfig),
    ]);

    await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);

    console.log("[build] Watching for changes...");
  } else {
    // Production build: run both builds
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
    ]);

    console.log("[build] Build complete");
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
