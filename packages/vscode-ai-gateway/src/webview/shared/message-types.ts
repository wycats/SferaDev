/**
 * Type-safe message definitions for extension ↔ webview communication.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Extension → Webview messages
// ─────────────────────────────────────────────────────────────────────────────

export interface UpdateContentMessage {
  type: "update";
  content: string;
  title: string;
}

export interface ThemeChangedMessage {
  type: "theme-changed";
  theme: "light" | "dark" | "high-contrast" | "high-contrast-light";
}

export type ExtensionMessage = UpdateContentMessage | ThemeChangedMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Webview → Extension messages
// ─────────────────────────────────────────────────────────────────────────────

export interface ReadyMessage {
  type: "ready";
}

export interface ActionMessage {
  type: "action";
  action: string;
  payload?: unknown;
}

export type WebviewMessage = ReadyMessage | ActionMessage;
