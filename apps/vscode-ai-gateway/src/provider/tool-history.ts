/**
 * Tool History Manager
 *
 * Manages tool call history and provides intelligent truncation to
 * conserve context tokens in long conversations.
 *
 * See RFC 010a: Tool Call Truncation for design details.
 */

import type { ItemParam } from "openresponses-client";
import type { TokenCounter } from "../tokens/counter.js";
import type { ToolHistoryStrategy } from "./tool-history-strategy.js";
import { TextEmbedStrategy } from "./tool-history-strategy.js";

/**
 * Simple logger interface for tool history.
 * Allows for dependency injection and testing without vscode.
 */
export interface ToolHistoryLogger {
  trace(message: string): void;
}

/**
 * Default no-op logger for testing.
 */
const noopLogger: ToolHistoryLogger = {
  trace: () => undefined,
};

/**
 * Categories of tool calls for truncation purposes.
 */
export type ToolCategory =
  | "read" // read_file, list_dir, grep_search, etc.
  | "write" // create_file, replace_string_in_file, etc.
  | "terminal" // run_in_terminal, get_terminal_output
  | "search" // semantic_search, file_search, list_code_usages
  | "other"; // Unknown tools

/**
 * A recorded tool call entry.
 */
export interface ToolCallEntry {
  /** Unique call ID */
  callId: string;
  /** Tool name */
  name: string;
  /** Tool arguments */
  args: Record<string, unknown>;
  /** Tool result (may be truncated for storage) */
  result: string;
  /** Whether the result indicates an error */
  isError: boolean;
  /** Timestamp when the call was made */
  timestamp: number;
  /** Estimated token count for this entry */
  tokenCount: number;
  /** Categorization for truncation purposes */
  category: ToolCategory;
}

/**
 * Configuration for tool history truncation.
 */
export interface TruncationConfig {
  /** Number of recent tool calls to keep in full detail */
  recentCallsToKeep: number;
  /** Maximum tokens for the historical summary */
  maxHistorySummaryTokens: number;
  /** Whether to preserve error details verbatim */
  preserveErrorsVerbatim: boolean;
  /** Token threshold at which to trigger truncation */
  truncationThreshold: number;
}

const DEFAULT_CONFIG: TruncationConfig = {
  recentCallsToKeep: 6, // Keep last 6 tool calls (roughly 3 call/result pairs)
  maxHistorySummaryTokens: 500,
  preserveErrorsVerbatim: true,
  truncationThreshold: 10000, // Start truncating when tool history exceeds 10k tokens
};

/**
 * Manages tool call history and provides intelligent truncation.
 */
export class ToolHistoryManager {
  private history: ToolCallEntry[] = [];
  private config: TruncationConfig;
  private tokenCounter: TokenCounter | undefined;
  private logger: ToolHistoryLogger;

  constructor(
    config: Partial<TruncationConfig> = {},
    tokenCounter?: TokenCounter,
    logger: ToolHistoryLogger = noopLogger,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tokenCounter = tokenCounter;
    this.logger = logger;
  }

  /**
   * Record a new tool call.
   */
  addToolCall(
    callId: string,
    name: string,
    args: Record<string, unknown>,
    result: string,
    isError: boolean,
  ): void {
    const category = categorizeToolCall(name);
    const tokenCount = this.estimateTokens(name, args, result);

    this.history.push({
      callId,
      name,
      args,
      result,
      isError,
      timestamp: Date.now(),
      tokenCount,
      category,
    });

    this.logger.trace(
      `[ToolHistory] Added ${name} (${category}): ${tokenCount.toString()} tokens, error=${String(isError)}`,
    );
  }

  /**
   * Get the current total token count of tool history.
   */
  getTotalTokens(): number {
    return this.history.reduce((sum, entry) => sum + entry.tokenCount, 0);
  }

  /**
   * Check if truncation is needed.
   */
  shouldTruncate(): boolean {
    return this.getTotalTokens() > this.config.truncationThreshold;
  }

  /**
   * Get the number of tool calls in history.
   */
  getHistoryLength(): number {
    return this.history.length;
  }

  /**
   * Generate a compacted representation of tool history.
   *
   * Returns an array of strings suitable for inclusion in messages:
   * - First element is a summary of older tool calls (if any)
   * - Remaining elements are recent tool calls in full detail
   */
  getCompactedHistory(): CompactedHistory {
    const totalCalls = this.history.length;
    const recentCount = Math.min(
      this.config.recentCallsToKeep,
      this.history.length,
    );

    if (totalCalls <= this.config.recentCallsToKeep) {
      // No truncation needed - return all entries as full detail
      return {
        summary: null,
        recentCalls: this.history.map((entry) => this.formatFullEntry(entry)),
        truncatedCount: 0,
        originalCount: totalCalls,
      };
    }

    // Split into older (to summarize) and recent (to keep)
    const olderEntries = this.history.slice(0, -recentCount);
    const recentEntries = this.history.slice(-recentCount);

    // Generate summary of older calls
    const summary = this.summarizeOldCalls(olderEntries);

    // Format recent calls in full detail
    const recentCalls = recentEntries.map((entry) =>
      this.formatFullEntry(entry),
    );

    return {
      summary,
      recentCalls,
      truncatedCount: olderEntries.length,
      originalCount: totalCalls,
    };
  }

  /**
   * Render tool history as OpenResponses input items using a strategy.
   *
   * @param strategy - The rendering strategy to use (defaults to TextEmbedStrategy)
   * @returns Array of ItemParam to inject into the conversation
   */
  renderAsItems(strategy?: ToolHistoryStrategy): ItemParam[] {
    const effectiveStrategy = strategy ?? new TextEmbedStrategy();
    const compacted = this.getCompactedHistory();
    const items: ItemParam[] = [];

    // Render summary if present
    if (compacted.summary) {
      items.push(...effectiveStrategy.renderSummary(compacted.summary));
    }

    // Render each recent call
    for (const entry of compacted.recentCalls) {
      items.push(...effectiveStrategy.renderEntry(entry));
    }

    return items;
  }

  /**
   * Clear all history.
   */
  clear(): void {
    this.history = [];
    this.logger.trace("[ToolHistory] Cleared all history");
  }

  /**
   * Format a single tool call entry for full inclusion.
   *
   * NOTE: We use HTML comment format (<!-- prior-tool: ... -->) instead of
   * bracket format ([Tool Call: ...]) to prevent models from mimicking the
   * format and outputting tool calls as text instead of using the actual
   * tool calling mechanism.
   */
  private formatFullEntry(entry: ToolCallEntry): FormattedToolEntry {
    const argsStr = JSON.stringify(entry.args);
    return {
      callText: `<!-- prior-tool: ${entry.name} | id: ${entry.callId} | args: ${argsStr} -->`,
      resultText: `<!-- prior-tool-result: ${entry.callId} -->\n${entry.result}`,
      isError: entry.isError,
    };
  }

  /**${entry.result}`,
      isError: entry.isError,
    };
  }

  /**
   * Summarize older tool calls into a concise representation.
   */
  private summarizeOldCalls(entries: ToolCallEntry[]): string {
    if (entries.length === 0) return "";

    const lines: string[] = ["[Earlier in this session:]"];
    const byCategory = this.groupByCategory(entries);

    // Summarize each category
    for (const [category, categoryEntries] of byCategory) {
      const summary = this.summarizeCategory(category, categoryEntries);
      if (summary) {
        lines.push(summary);
      }
    }

    // Add error summaries if preserving errors
    if (this.config.preserveErrorsVerbatim) {
      const errors = entries.filter((e) => e.isError);
      if (errors.length > 0) {
        lines.push("");
        lines.push("[Errors encountered:]");
        for (const error of errors) {
          // Keep error messages relatively detailed
          const truncatedResult =
            error.result.length > 200
              ? `${error.result.slice(0, 200)}...`
              : error.result;
          lines.push(`- ${error.name}: ${truncatedResult}`);
        }
      }
    }

    return lines.join("\n");
  }

  /**
   * Summarize a category of tool calls.
   */
  private summarizeCategory(
    category: ToolCategory,
    entries: ToolCallEntry[],
  ): string {
    const nonErrorEntries = entries.filter((e) => !e.isError);
    if (nonErrorEntries.length === 0) return "";

    switch (category) {
      case "read": {
        // Extract unique file paths
        const paths = [
          ...new Set(
            nonErrorEntries
              .map((e) => {
                const path =
                  (e.args as { filePath?: string; path?: string }).filePath ??
                  (e.args as { path?: string }).path;
                return path ?? "unknown";
              })
              .filter((p) => p !== "unknown"),
          ),
        ];
        const pathPreview = paths.slice(0, 3).join(", ");
        const more =
          paths.length > 3 ? `, +${(paths.length - 3).toString()} more` : "";
        return `- Read ${nonErrorEntries.length.toString()} file(s): ${pathPreview}${more}`;
      }

      case "write": {
        const paths = [
          ...new Set(
            nonErrorEntries.map((e) => {
              const path =
                (e.args as { filePath?: string }).filePath ?? "unknown";
              return path;
            }),
          ),
        ];
        return `- Made ${nonErrorEntries.length.toString()} edit(s) to: ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? "..." : ""}`;
      }

      case "terminal": {
        const commands = nonErrorEntries.map((e) => {
          const cmd = (e.args as { command?: string }).command ?? "command";
          // Truncate long commands
          return cmd.length > 50 ? `${cmd.slice(0, 50)}...` : cmd;
        });
        return `- Ran ${nonErrorEntries.length.toString()} terminal command(s): ${commands.slice(0, 2).join("; ")}${commands.length > 2 ? "; ..." : ""}`;
      }

      case "search": {
        const queries = nonErrorEntries.map(
          (e) =>
            (e.args as { query?: string }).query ??
            (e.args as { symbolName?: string }).symbolName ??
            "search",
        );
        return `- Performed ${nonErrorEntries.length.toString()} search(es): ${queries.slice(0, 2).join(", ")}${queries.length > 2 ? "..." : ""}`;
      }
      default: {
        const tools = [...new Set(nonErrorEntries.map((e) => e.name))];
        return `- Used ${nonErrorEntries.length.toString()} other tool(s): ${tools.slice(0, 3).join(", ")}${tools.length > 3 ? "..." : ""}`;
      }
    }
  }

  /**
   * Group entries by their category.
   */
  private groupByCategory(
    entries: ToolCallEntry[],
  ): Map<ToolCategory, ToolCallEntry[]> {
    const groups = new Map<ToolCategory, ToolCallEntry[]>();

    for (const entry of entries) {
      const existing = groups.get(entry.category) ?? [];
      existing.push(entry);
      groups.set(entry.category, existing);
    }

    return groups;
  }

  /**
   * Estimate token count for a tool call entry.
   */
  private estimateTokens(
    name: string,
    args: Record<string, unknown>,
    result: string,
  ): number {
    // If we have a token counter, use it
    if (this.tokenCounter) {
      const text = `${name} ${JSON.stringify(args)} ${result}`;
      return this.tokenCounter.estimateTextTokens(text, "claude");
    }

    // Otherwise, use a rough estimate: ~4 chars per token
    const totalChars =
      name.length + JSON.stringify(args).length + result.length;
    return Math.ceil(totalChars / 4);
  }
}

/**
 * Compacted history result.
 */
export interface CompactedHistory {
  /** Summary of older tool calls, or null if no truncation */
  summary: string | null;
  /** Recent tool calls in full detail */
  recentCalls: FormattedToolEntry[];
  /** Number of tool calls that were truncated */
  truncatedCount: number;
  /** Original total count */
  originalCount: number;
}

/**
 * Formatted tool call entry.
 */
export interface FormattedToolEntry {
  /** The tool call text */
  callText: string;
  /** The tool result text */
  resultText: string;
  /** Whether this was an error */
  isError: boolean;
}

/**
 * Categorize a tool call by its name.
 */
export function categorizeToolCall(name: string): ToolCategory {
  const lowerName = name.toLowerCase();

  // Read operations
  if (
    lowerName.includes("read") ||
    lowerName.includes("get_file") ||
    lowerName.includes("list_dir") ||
    lowerName.includes("grep") ||
    lowerName.includes("fetch")
  ) {
    return "read";
  }

  // Write operations
  if (
    lowerName.includes("create") ||
    lowerName.includes("write") ||
    lowerName.includes("replace") ||
    lowerName.includes("edit") ||
    lowerName.includes("delete")
  ) {
    return "write";
  }

  // Terminal operations
  if (
    lowerName.includes("terminal") ||
    lowerName.includes("run_in") ||
    lowerName.includes("exec") ||
    lowerName.includes("shell")
  ) {
    return "terminal";
  }

  // Search operations
  if (
    lowerName.includes("search") ||
    lowerName.includes("find") ||
    lowerName.includes("usage") ||
    lowerName.includes("semantic")
  ) {
    return "search";
  }

  return "other";
}

/**
 * Analyze tool call patterns in a message list and compute truncation decisions.
 *
 * This is a stateless analysis function that can be called on the full message
 * history to determine which tool calls should be summarized vs kept in full.
 *
 * @param toolCalls - Array of tool call entries extracted from messages
 * @param config - Truncation configuration
 * @returns Truncation decision with summary for older calls
 */
export function computeTruncation(
  toolCalls: ToolCallEntry[],
  config: Partial<TruncationConfig> = {},
): TruncationDecision {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const totalCalls = toolCalls.length;

  // Check if truncation is needed
  const totalTokens = toolCalls.reduce((sum, tc) => sum + tc.tokenCount, 0);
  const needsTruncation = totalTokens > mergedConfig.truncationThreshold;

  if (!needsTruncation || totalCalls <= mergedConfig.recentCallsToKeep) {
    // No truncation needed
    return {
      shouldTruncate: false,
      summary: null,
      recentCallIds: new Set(toolCalls.map((tc) => tc.callId)),
      truncatedCallIds: new Set(),
      tokensSaved: 0,
    };
  }

  // Split into older (truncate) and recent (keep)
  const recentCount = Math.min(mergedConfig.recentCallsToKeep, totalCalls);
  const olderCalls = toolCalls.slice(0, -recentCount);
  const recentCalls = toolCalls.slice(-recentCount);

  // Generate summary
  const summary = generateTruncationSummary(olderCalls, mergedConfig);

  // Calculate tokens saved
  const olderTokens = olderCalls.reduce((sum, tc) => sum + tc.tokenCount, 0);
  const summaryTokens = Math.ceil(summary.length / 4); // Rough estimate
  const tokensSaved = Math.max(0, olderTokens - summaryTokens);

  return {
    shouldTruncate: true,
    summary,
    recentCallIds: new Set(recentCalls.map((tc) => tc.callId)),
    truncatedCallIds: new Set(olderCalls.map((tc) => tc.callId)),
    tokensSaved,
  };
}

/**
 * Decision about how to truncate tool history.
 */
export interface TruncationDecision {
  /** Whether truncation is being applied */
  shouldTruncate: boolean;
  /** Summary text for older tool calls, or null if no truncation */
  summary: string | null;
  /** Set of call IDs that should be kept in full detail */
  recentCallIds: Set<string>;
  /** Set of call IDs that have been truncated into the summary */
  truncatedCallIds: Set<string>;
  /** Estimated tokens saved by truncation */
  tokensSaved: number;
}

/**
 * Generate a summary for truncated tool calls.
 */
function generateTruncationSummary(
  entries: ToolCallEntry[],
  config: TruncationConfig,
): string {
  if (entries.length === 0) return "";

  const lines: string[] = ["[Earlier in this session:]"];
  const byCategory = groupByCategory(entries);

  // Summarize each category
  for (const [category, categoryEntries] of byCategory) {
    const summary = summarizeCategoryEntries(category, categoryEntries);
    if (summary) {
      lines.push(summary);
    }
  }

  // Add error summaries if preserving errors
  if (config.preserveErrorsVerbatim) {
    const errors = entries.filter((e) => e.isError);
    if (errors.length > 0) {
      lines.push("");
      lines.push("[Errors encountered:]");
      for (const error of errors) {
        // Keep error messages relatively detailed
        const truncatedResult =
          error.result.length > 200
            ? `${error.result.slice(0, 200)}...`
            : error.result;
        lines.push(`- ${error.name}: ${truncatedResult}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Group entries by category.
 */
function groupByCategory(
  entries: ToolCallEntry[],
): Map<ToolCategory, ToolCallEntry[]> {
  const groups = new Map<ToolCategory, ToolCallEntry[]>();

  for (const entry of entries) {
    const existing = groups.get(entry.category) ?? [];
    existing.push(entry);
    groups.set(entry.category, existing);
  }

  return groups;
}

/**
 * Summarize entries for a category.
 */
function summarizeCategoryEntries(
  category: ToolCategory,
  entries: ToolCallEntry[],
): string {
  const nonErrorEntries = entries.filter((e) => !e.isError);
  if (nonErrorEntries.length === 0) return "";

  switch (category) {
    case "read": {
      const paths = [
        ...new Set(
          nonErrorEntries
            .map((e) => {
              const path =
                (e.args as { filePath?: string; path?: string }).filePath ??
                (e.args as { path?: string }).path;
              return path ?? "unknown";
            })
            .filter((p) => p !== "unknown"),
        ),
      ];
      const pathPreview = paths.slice(0, 3).join(", ");
      const more =
        paths.length > 3 ? `, +${(paths.length - 3).toString()} more` : "";
      return `- Read ${nonErrorEntries.length.toString()} file(s): ${pathPreview}${more}`;
    }

    case "write": {
      const paths = [
        ...new Set(
          nonErrorEntries.map((e) => {
            const path =
              (e.args as { filePath?: string }).filePath ?? "unknown";
            return path;
          }),
        ),
      ];
      return `- Made ${nonErrorEntries.length.toString()} edit(s) to: ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? "..." : ""}`;
    }

    case "terminal": {
      const commands = nonErrorEntries.map((e) => {
        const cmd = (e.args as { command?: string }).command ?? "command";
        return cmd.length > 50 ? `${cmd.slice(0, 50)}...` : cmd;
      });
      return `- Ran ${nonErrorEntries.length.toString()} terminal command(s): ${commands.slice(0, 2).join("; ")}${commands.length > 2 ? "; ..." : ""}`;
    }

    case "search": {
      const queries = nonErrorEntries.map(
        (e) =>
          (e.args as { query?: string }).query ??
          (e.args as { symbolName?: string }).symbolName ??
          "search",
      );
      return `- Performed ${nonErrorEntries.length.toString()} search(es): ${queries.slice(0, 2).join(", ")}${queries.length > 2 ? "..." : ""}`;
    }
    default: {
      const tools = [...new Set(nonErrorEntries.map((e) => e.name))];
      return `- Used ${nonErrorEntries.length.toString()} other tool(s): ${tools.slice(0, 3).join(", ")}${tools.length > 3 ? "..." : ""}`;
    }
  }
}

/**
 * Estimate token count for content.
 */
export function estimateTokens(content: string): number {
  // Rough estimate: ~4 characters per token
  return Math.ceil(content.length / 4);
}
