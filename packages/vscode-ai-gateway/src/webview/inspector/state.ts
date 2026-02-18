/**
 * Reactive state store for the inspector webview.
 *
 * Uses Svelte's writable store for proper reactivity.
 * Components subscribe to this store and re-render automatically
 * when the extension sends new content via postMessage.
 */

import { writable } from "svelte/store";
import { getState, setState } from "../shared/vscode-api.js";
import type { InspectorData } from "../shared/inspector-data.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface InspectorState {
  data: InspectorData | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

// Restore state from VS Code's webview state API (survives hide/show)
const initialState: InspectorState = getState<InspectorState>() ?? {
  data: null,
};

// Create the writable store
const { subscribe, set } = writable<InspectorState>(initialState);

// Persist state changes to VS Code's webview state API
subscribe((state) => {
  setState(state);
});

/**
 * The inspector state store.
 *
 * Subscribe in components: `$inspectorState`
 * Update from message handler: `inspectorState.setData(data)`
 */
export const inspectorState = {
  subscribe,

  /**
   * Update the inspector data.
   * Called when the extension sends an 'update' message.
   */
  setData(data: InspectorData): void {
    set({ data });
  },
};
