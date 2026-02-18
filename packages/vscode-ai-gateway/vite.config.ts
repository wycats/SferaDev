/**
 * Vite configuration for the webview bundle.
 *
 * Uses Vite's native code splitting for lazy-loaded Shiki languages.
 * The extension build still uses esbuild (see scripts/build.mjs).
 */

import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolve } from "path";

export default defineConfig({
  plugins: [
    svelte({
      compilerOptions: {
        // Inject CSS into JS (simpler CSP, no separate CSS file)
        css: "injected",
      },
    }),
  ],

  build: {
    // Output to out/webview/ to match existing structure
    outDir: "out/webview",
    emptyOutDir: true,

    rollupOptions: {
      input: resolve(__dirname, "src/webview/inspector/main.ts"),
      output: {
        // Predictable entry point name
        entryFileNames: "main.js",
        // Put lazy-loaded chunks in a predictable location
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },

    // Minify for production
    minify: true,
    sourcemap: false,

    // Target modern browsers (VS Code's webview uses Chromium)
    target: "esnext",
  },

  // Resolve Svelte properly
  resolve: {
    conditions: ["svelte", "browser"],
  },
});
