/**
 * Safe Serialization Utilities
 *
 * Provides safe alternatives to JSON.stringify that handle circular references
 * and other edge cases that can cause stack overflow errors.
 *
 * Use cases:
 * - safeJsonStringify(): For JSONL output where valid JSON is required
 * - safeInspect(): For debug logging where human readability is preferred
 */

import { inspect } from "node:util";
import stringify from "safe-stable-stringify";

/**
 * Safely stringify a value to JSON, handling circular references.
 *
 * Circular references are replaced with "[Circular]" string.
 * Returns "null" if the value cannot be stringified.
 *
 * Use this for:
 * - JSONL log files (tree-diagnostics, forensic-capture)
 * - Any output that must be valid JSON
 *
 * @param value - The value to stringify
 * @param space - Optional indentation (like JSON.stringify)
 * @returns Valid JSON string
 */
export function safeJsonStringify(value: unknown, space?: number): string {
  const result = stringify(value, null, space);
  // stringify returns undefined for undefined, functions, symbols
  return result ?? "null";
}

/**
 * Safely inspect a value for debug logging.
 *
 * Uses Node's util.inspect which handles:
 * - Circular references (shows [Circular])
 * - Large objects (truncates with depth limit)
 * - Special types (Map, Set, Buffer, etc.)
 *
 * Use this for:
 * - Debug log messages
 * - Error context
 * - Any output where human readability > JSON validity
 *
 * @param value - The value to inspect
 * @param depth - Maximum depth to traverse (default: 4)
 * @returns Human-readable string representation
 */
export function safeInspect(value: unknown, depth = 4): string {
  return inspect(value, {
    depth,
    colors: false,
    maxStringLength: 1000,
    breakLength: Infinity, // Don't wrap lines
  });
}

/**
 * Safely stringify a value, with fallback to inspect on failure.
 *
 * Attempts JSON.stringify first (for performance), falls back to
 * safeJsonStringify if that fails.
 *
 * Use this when you expect the value to usually be safe but want
 * protection against edge cases.
 *
 * @param value - The value to stringify
 * @returns JSON string (falls back to safeJsonStringify on error)
 */
export function tryStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return safeJsonStringify(value);
  }
}
