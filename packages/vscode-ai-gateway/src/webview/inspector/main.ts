/**
 * Inspector webview entry point.
 *
 * This is the main entry point for the inspector webview bundle.
 * Compiled by esbuild with the svelte plugin.
 *
 * Uses a Svelte store for reactive state management. The extension
 * sends content via postMessage, which updates the store, and the
 * App component re-renders automatically via store subscription.
 */

import { mount } from "svelte";
import App from "./App.svelte";
import { postMessage } from "../shared/vscode-api.js";
import { inspectorState } from "./state.js";
import type { ExtensionMessage } from "../shared/message-types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Svelte App
// ─────────────────────────────────────────────────────────────────────────────

const target = document.getElementById("app");
if (!target) {
  throw new Error("Could not find #app element");
}

// Mount once — store reactivity handles updates
mount(App, { target });

// ─────────────────────────────────────────────────────────────────────────────
// Message handling
// ─────────────────────────────────────────────────────────────────────────────

window.addEventListener("message", (event: MessageEvent<ExtensionMessage>) => {
  const message = event.data;

  switch (message.type) {
    case "update":
      // Update store — App component re-renders automatically
      inspectorState.setContent(message.content, message.title);
      break;

    case "theme-changed":
      // Theme is handled by VS Code CSS variables automatically
      break;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────────────────────

// Notify extension that webview is ready
postMessage({ type: "ready" });

console.log("[Inspector] Webview initialized");
