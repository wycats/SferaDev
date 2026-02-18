/**
 * Type-safe message definitions for extension ↔ webview communication.
 */

import type { InspectorData } from "./inspector-data.js";

// ─────────────────────────────────────────────────────────────────────────────
// Extension → Webview messages
// ─────────────────────────────────────────────────────────────────────────────

export interface UpdateContentMessage {
  type: "update";
  data: InspectorData;
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

export interface OpenFileMessage {
  type: "open-file";
  absolutePath: string;
  startLine?: number;
  endLine?: number;
}

export type WebviewMessage = ReadyMessage | ActionMessage | OpenFileMessage;
