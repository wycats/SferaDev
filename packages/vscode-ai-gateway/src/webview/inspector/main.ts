/**
 * Inspector webview entry point.
 *
 * This is the main entry point for the inspector webview bundle.
 * It will be compiled by esbuild with the svelte plugin.
 */

import { postMessage, getState, setState } from "../shared/vscode-api.js";
import type { ExtensionMessage } from "../shared/message-types.js";

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

interface InspectorState {
  content: string;
  title: string;
}

let state: InspectorState = getState<InspectorState>() ?? {
  content: "",
  title: "Inspector",
};

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

function render(): void {
  const app = document.getElementById("app");
  if (!app) return;

  // Simple preformatted text rendering for now
  // Will be replaced with Svelte components in Phase 2
  app.innerHTML = `
    <h1>${escapeHtml(state.title)}</h1>
    <pre style="white-space: pre-wrap; word-wrap: break-word;">${escapeHtml(state.content)}</pre>
  `;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─────────────────────────────────────────────────────────────────────────────
// Message handling
// ─────────────────────────────────────────────────────────────────────────────

window.addEventListener("message", (event: MessageEvent<ExtensionMessage>) => {
  const message = event.data;

  switch (message.type) {
    case "update":
      state = { content: message.content, title: message.title };
      setState(state);
      render();
      break;

    case "theme-changed":
      // Theme is handled by VS Code CSS variables automatically
      break;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────────────────────

// Initial render with restored state
render();

// Notify extension that webview is ready
postMessage({ type: "ready" });

console.log("[Inspector] Webview initialized");
