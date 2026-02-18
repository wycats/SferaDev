#!/usr/bin/env node
/**
 * Build script for the VS Code extension.
 *
 * Runs two builds:
 * 1. Extension build (esbuild, Node ESM) → out/extension.js
 * 2. Webview build (Vite, browser ESM, Svelte) → out/webview/
 *
 * Usage:
 *   node scripts/build.mjs          # Production build (minified)
 *   node scripts/build.mjs --watch  # Development mode with watch
 */

import * as esbuild from "esbuild";
import { build as viteBuild, createServer } from "vite";

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
// Webview build (Vite)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build webview with Vite (supports code splitting for lazy language loading)
 */
async function buildWebview() {
  await viteBuild({
    configFile: "./vite.config.ts",
    mode: isMinify ? "production" : "development",
    build: {
      minify: isMinify,
      sourcemap: !isMinify,
    },
    logLevel: "info",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Build execution
// ─────────────────────────────────────────────────────────────────────────────

async function build() {
  if (isWatch) {
    // Watch mode: esbuild watch + Vite watch
    const extensionCtx = await esbuild.context(extensionConfig);
    await extensionCtx.watch();

    // Vite watch mode via build with watch option
    await viteBuild({
      configFile: "./vite.config.ts",
      mode: "development",
      build: {
        watch: {},
        sourcemap: true,
      },
      logLevel: "info",
    });

    console.log("[build] Watching for changes...");
  } else {
    // Production build: run both builds in parallel
    await Promise.all([esbuild.build(extensionConfig), buildWebview()]);

    console.log("[build] Build complete");
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
