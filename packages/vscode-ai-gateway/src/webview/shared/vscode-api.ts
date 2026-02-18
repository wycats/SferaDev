/**
 * Type-safe wrapper for VS Code webview API.
 *
 * The VS Code API is only available inside webviews and can only be
 * acquired once per webview lifecycle.
 */

// Declare the global acquireVsCodeApi function provided by VS Code
declare function acquireVsCodeApi(): VsCodeApi;

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

// Acquire the API once and cache it
let vscodeApi: VsCodeApi | undefined;

/**
 * Get the VS Code API instance.
 * Safe to call multiple times — returns cached instance.
 */
export function getVsCodeApi(): VsCodeApi {
  if (!vscodeApi) {
    vscodeApi = acquireVsCodeApi();
  }
  return vscodeApi;
}

/**
 * Post a message to the extension host.
 */
export function postMessage(message: unknown): void {
  getVsCodeApi().postMessage(message);
}

/**
 * Get persisted webview state.
 */
export function getState<T>(): T | undefined {
  return getVsCodeApi().getState() as T | undefined;
}

/**
 * Persist webview state (survives panel hide/show).
 */
export function setState<T>(state: T): void {
  getVsCodeApi().setState(state);
}
