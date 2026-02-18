/**
 * Reactive state store for the inspector webview.
 *
 * Uses Svelte's writable store for proper reactivity.
 * Components subscribe to this store and re-render automatically
 * when the extension sends new content via postMessage.
 */

import { writable } from "svelte/store";
import { getState, setState } from "../shared/vscode-api.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface InspectorState {
  content: string;
  title: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

// Restore state from VS Code's webview state API (survives hide/show)
const initialState: InspectorState = getState<InspectorState>() ?? {
  content: "",
  title: "Inspector",
};

// Create the writable store
const { subscribe, set, update } = writable<InspectorState>(initialState);

// Persist state changes to VS Code's webview state API
subscribe((state) => {
  setState(state);
});

/**
 * The inspector state store.
 *
 * Subscribe in components: `$inspectorState`
 * Update from message handler: `inspectorState.setContent(content, title)`
 */
export const inspectorState = {
  subscribe,

  /**
   * Update the inspector content and title.
   * Called when the extension sends an 'update' message.
   */
  setContent(content: string, title: string): void {
    set({ content, title });
  },

  /**
   * Update just the title (e.g., for loading states).
   */
  setTitle(title: string): void {
    update((state) => ({ ...state, title }));
  },
};
