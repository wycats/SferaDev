/**
 * Tool call label generation — pure functions for summarizing tool args
 * and selecting tool-category icons.
 *
 * These functions are used by ToolCallItem to produce meaningful labels
 * instead of raw arg dumps. Each known tool gets a custom summarizer
 * that extracts the most useful information; unknown tools fall back
 * to a generic first-2-values approach.
 */

/** Maximum length for path/command values in summaries. */
const MAX_PATH_LEN = 40;
/** Maximum length for query/search values in summaries. */
const MAX_QUERY_LEN = 30;

// ── Arg Summarization ────────────────────────────────────────────────

/**
 * Produce a concise, human-readable summary of a tool call's arguments.
 *
 * Known tools get a custom summarizer that extracts the most meaningful
 * arg(s). Unknown tools fall back to showing the first 2 arg values.
 *
 * @returns Summary string (without the tool name — caller prepends it).
 */
export function summarizeToolArgs(
  name: string,
  args: Record<string, unknown>,
): string {
  const summarizer = TOOL_SUMMARIZERS[name];
  if (summarizer) {
    const result = summarizer(args);
    if (result) return result;
  }
  return genericSummary(args);
}

/** Extract a string arg, returning undefined if missing or wrong type. */
function str(args: Record<string, unknown>, key: string): string | undefined {
  const val = args[key];
  return typeof val === "string" ? val : undefined;
}

/** Extract a number arg, returning undefined if missing or wrong type. */
function num(args: Record<string, unknown>, key: string): number | undefined {
  const val = args[key];
  return typeof val === "number" ? val : undefined;
}

/** Truncate a string to maxLen, adding ellipsis if needed. */
function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen - 3)}...`;
}

/** Strip leading workspace-like prefixes for shorter display. */
function shortenPath(filePath: string): string {
  // Remove common prefixes that add noise
  return filePath
    .replace(/^\/var\/home\/[^/]+\/Code\/[^/]+\/[^/]+\//, "")
    .replace(/^\/home\/[^/]+\//, "~/");
}

/**
 * Summarize a file path with optional line range.
 * Used by read_file, replace_string_in_file, create_file, etc.
 */
function fileSummary(
  args: Record<string, unknown>,
  pathKey = "filePath",
): string | undefined {
  const filePath = str(args, pathKey);
  if (!filePath) return undefined;

  const short = shortenPath(filePath);
  const startLine = num(args, "startLine");
  const endLine = num(args, "endLine");

  if (startLine !== undefined && endLine !== undefined) {
    return truncate(`${short} L${startLine}-L${endLine}`, MAX_PATH_LEN);
  }
  if (startLine !== undefined) {
    return truncate(`${short} L${startLine}`, MAX_PATH_LEN);
  }
  return truncate(short, MAX_PATH_LEN);
}

/** Per-tool summarizer dispatch table. */
const TOOL_SUMMARIZERS: Record<
  string,
  (args: Record<string, unknown>) => string | undefined
> = {
  read_file: (args) => fileSummary(args),

  replace_string_in_file: (args) => fileSummary(args),

  multi_replace_string_in_file: (args) => {
    const replacements = args["replacements"];
    if (Array.isArray(replacements)) {
      return `${replacements.length} replacement${replacements.length === 1 ? "" : "s"}`;
    }
    return undefined;
  },

  create_file: (args) => fileSummary(args),

  create_directory: (args) => {
    const dirPath = str(args, "dirPath");
    if (!dirPath) return undefined;
    return truncate(shortenPath(dirPath), MAX_PATH_LEN);
  },

  edit_notebook_file: (args) => fileSummary(args),

  grep_search: (args) => {
    const query = str(args, "query");
    if (!query) return undefined;
    const pattern = str(args, "includePattern");
    const base = truncate(query, MAX_QUERY_LEN);
    if (pattern) {
      return `${base} in ${truncate(pattern, 20)}`;
    }
    return base;
  },

  semantic_search: (args) => {
    const query = str(args, "query");
    if (!query) return undefined;
    return truncate(query, MAX_QUERY_LEN);
  },

  file_search: (args) => {
    const query = str(args, "query");
    if (!query) return undefined;
    return truncate(query, MAX_QUERY_LEN);
  },

  list_dir: (args) => {
    const path = str(args, "path");
    if (!path) return undefined;
    return truncate(shortenPath(path), MAX_PATH_LEN);
  },

  run_in_terminal: (args) => {
    const command = str(args, "command");
    if (!command) return undefined;
    return truncate(command, MAX_PATH_LEN);
  },

  list_code_usages: (args) => {
    const symbol = str(args, "symbolName");
    if (!symbol) return undefined;
    return symbol;
  },

  get_errors: (args) => {
    const paths = args["filePaths"];
    if (Array.isArray(paths) && paths.length > 0) {
      return `${paths.length} file${paths.length === 1 ? "" : "s"}`;
    }
    return "all files";
  },

  fetch_webpage: (args) => {
    const urls = args["urls"];
    if (Array.isArray(urls) && urls.length > 0) {
      const first = typeof urls[0] === "string" ? urls[0] : undefined;
      if (first) {
        try {
          return new URL(first).hostname;
        } catch {
          return truncate(first, MAX_QUERY_LEN);
        }
      }
    }
    return undefined;
  },

  runSubagent: (args) => {
    const desc = str(args, "description");
    if (desc) return truncate(desc, MAX_QUERY_LEN);
    const agentName = str(args, "agentName");
    if (agentName) return agentName;
    return undefined;
  },
};

/**
 * Generic fallback: show first 2 arg values, truncated.
 * Used for unknown tools.
 */
function genericSummary(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "";

  return keys
    .slice(0, 2)
    .map((key) => {
      const val = args[key];
      if (typeof val === "string") {
        return truncate(val, MAX_QUERY_LEN);
      }
      if (val === undefined || val === null) return "";
      return String(val).slice(0, 20);
    })
    .filter(Boolean)
    .join(", ");
}

// ── Tool Category Icons ──────────────────────────────────────────────

/** VS Code ThemeIcon id for a tool, based on its category. */
export function toolIcon(name: string): string {
  return TOOL_ICONS[name] ?? "wrench";
}

/** Per-tool icon mapping. */
const TOOL_ICONS: Record<string, string> = {
  // File operations
  read_file: "go-to-file",
  create_file: "new-file",
  create_directory: "new-folder",
  edit_notebook_file: "notebook",

  // Edit operations
  replace_string_in_file: "edit",
  multi_replace_string_in_file: "edit",

  // Search operations
  grep_search: "search",
  semantic_search: "search",
  file_search: "search",
  list_code_usages: "references",

  // Directory/navigation
  list_dir: "folder-opened",

  // Terminal
  run_in_terminal: "terminal",

  // Diagnostics
  get_errors: "warning",

  // Web
  fetch_webpage: "globe",
  open_simple_browser: "globe",

  // Agents
  runSubagent: "rocket",

  // Notebook
  run_notebook_cell: "play",
  read_notebook_cell_output: "output",
};
