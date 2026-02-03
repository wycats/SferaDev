/**
 * Synthetic Part Types
 *
 * Internal type system for richer semantic representation of response parts.
 * These types capture semantics that VS Code's API doesn't directly support,
 * allowing us to:
 * 1. Have richer internal semantics
 * 2. Change rendering without touching event handlers
 * 3. Prepare for future VS Code APIs (e.g., ThinkingPart)
 * 4. Enable filtering/transformation at the emission boundary
 */

import * as vscode from "vscode";

// ============================================================================
// Synthetic Part Types
// ============================================================================

/**
 * Plain text content - the most common part type.
 */
export interface TextPart {
  readonly kind: "text";
  readonly content: string;
}

/**
 * Reasoning/thinking content from extended thinking models (o1, Claude).
 * Will use LanguageModelThinkingPart when the proposed API is available.
 */
export interface ThinkingPart {
  readonly kind: "thinking";
  readonly content: string;
  readonly id?: string;
}

/**
 * Model refusal to provide content.
 * Rendered with visual distinction (e.g., italics).
 */
export interface RefusalPart {
  readonly kind: "refusal";
  readonly content: string;
}

/**
 * URL citation/annotation from the model.
 * Rendered as inline markdown link.
 */
export interface CitationPart {
  readonly kind: "citation";
  readonly url: string;
  readonly title: string;
}

/**
 * Tool call - already well-supported by VS Code.
 */
export interface ToolCallPart {
  readonly kind: "tool_call";
  readonly callId: string;
  readonly name: string;
  readonly input: object;
}

/**
 * Binary/structured data (images, files, JSON).
 */
export interface DataPart {
  readonly kind: "data";
  readonly data: Uint8Array;
  readonly mimeType: string;
}

/**
 * Error that occurred during streaming.
 * May be rendered as text or thrown as LanguageModelError.
 */
export interface ErrorPart {
  readonly kind: "error";
  readonly message: string;
  readonly code?: string;
}

/**
 * Union of all synthetic part types.
 */
export type SyntheticPart =
  | TextPart
  | ThinkingPart
  | RefusalPart
  | CitationPart
  | ToolCallPart
  | DataPart
  | ErrorPart;

// ============================================================================
// Proposed API Detection
// ============================================================================

/**
 * Type-safe access to LanguageModelThinkingPart.
 * Returns undefined in stable VS Code where the proposed API is unavailable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
export const VSCodeThinkingPart = (vscode as any).LanguageModelThinkingPart as
  | (new (
      value: string | string[],
      id?: string,
    ) => vscode.LanguageModelTextPart)
  | undefined;

/**
 * Check if ThinkingPart is available at runtime.
 */
export function hasThinkingPartSupport(): boolean {
  return VSCodeThinkingPart !== undefined;
}

// ============================================================================
// Conversion to VS Code Types
// ============================================================================

/**
 * Options for converting synthetic parts to VS Code types.
 */
export interface ConversionOptions {
  /**
   * If true, emit ThinkingPart when available (proposed API).
   * If false or unavailable, fall back to TextPart.
   */
  useThinkingPart?: boolean;

  /**
   * If true, format refusals with italic markdown.
   * If false, emit as plain text.
   */
  formatRefusals?: boolean;

  /**
   * If true, emit citations as inline markdown links.
   * If false, suppress citations.
   */
  emitCitations?: boolean;
}

const DEFAULT_OPTIONS: ConversionOptions = {
  useThinkingPart: true,
  formatRefusals: true,
  emitCitations: true,
};

/**
 * Convert a synthetic part to VS Code's LanguageModelResponsePart.
 *
 * Returns undefined for parts that should be suppressed or handled separately
 * (e.g., errors that should be thrown).
 */
export function toVSCodePart(
  part: SyntheticPart,
  options: ConversionOptions = DEFAULT_OPTIONS,
): vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart | undefined {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  switch (part.kind) {
    case "text":
      return new vscode.LanguageModelTextPart(part.content);

    case "thinking":
      if (opts.useThinkingPart && VSCodeThinkingPart) {
        return new VSCodeThinkingPart(part.content, part.id);
      }
      // Fallback: emit as plain text
      return new vscode.LanguageModelTextPart(part.content);

    case "refusal":
      if (opts.formatRefusals) {
        // Wrap in italics to visually distinguish
        return new vscode.LanguageModelTextPart(`*${part.content}*`);
      }
      return new vscode.LanguageModelTextPart(part.content);

    case "citation":
      if (opts.emitCitations) {
        return new vscode.LanguageModelTextPart(
          ` [${part.title}](${part.url})`,
        );
      }
      return undefined;

    case "tool_call":
      return new vscode.LanguageModelToolCallPart(
        part.callId,
        part.name,
        part.input,
      );

    case "data":
      // LanguageModelDataPart is not rendered in chat UI
      // For now, we don't emit it - consumers can handle via other means
      // TODO: When we have a use case, add DataPart emission
      return undefined;

    case "error":
      // Errors are handled separately - they may be thrown or emitted as text
      // depending on whether content has already been sent
      return new vscode.LanguageModelTextPart(
        `\n\n**Error:** ${part.message}\n\n`,
      );
  }
}

/**
 * Convert multiple synthetic parts to VS Code parts.
 * Filters out undefined results.
 */
export function toVSCodeParts(
  parts: SyntheticPart[],
  options?: ConversionOptions,
): (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] {
  return parts
    .map((p) => toVSCodePart(p, options))
    .filter(
      (
        p,
      ): p is vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart =>
        p !== undefined,
    );
}

// ============================================================================
// Factory Functions
// ============================================================================

export function text(content: string): TextPart {
  return { kind: "text", content };
}

export function thinking(content: string, id?: string): ThinkingPart {
  if (id !== undefined) {
    return { kind: "thinking", content, id };
  }
  return { kind: "thinking", content };
}

export function refusal(content: string): RefusalPart {
  return { kind: "refusal", content };
}

export function citation(url: string, title: string): CitationPart {
  return { kind: "citation", url, title };
}

export function toolCall(
  callId: string,
  name: string,
  input: object,
): ToolCallPart {
  return { kind: "tool_call", callId, name, input };
}

export function data(bytes: Uint8Array, mimeType: string): DataPart {
  return { kind: "data", data: bytes, mimeType };
}

export function error(message: string, code?: string): ErrorPart {
  if (code !== undefined) {
    return { kind: "error", message, code };
  }
  return { kind: "error", message };
}
