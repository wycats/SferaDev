/**
 * Inspector webview entry point.
 *
 * This is the main entry point for the inspector webview bundle.
 * Compiled by esbuild with the svelte plugin.
 */

import { mount, unmount } from "svelte";
import App from "./App.svelte";
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
// Svelte App
// ─────────────────────────────────────────────────────────────────────────────

const target = document.getElementById("app");
if (!target) {
  throw new Error("Could not find #app element");
}

// Current mounted app instance
let app: ReturnType<typeof mount> | null = null;

/**
 * Mount or remount the Svelte app with current state.
 * Svelte 5's mount() doesn't support prop updates, so we unmount/remount.
 */
function render(): void {
  if (app) {
    unmount(app);
  }
  app = mount(App, {
    target: target!,
    props: state,
  });
}

// Initial render with restored state
render();

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

// Notify extension that webview is ready
postMessage({ type: "ready" });

console.log("[Inspector] Webview initialized");
