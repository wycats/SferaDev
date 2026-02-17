import { describe, it, expect } from "vitest";
import { summarizeToolArgs, toolIcon } from "./tool-labels.js";

describe("summarizeToolArgs", () => {
  // ── File tools ───────────────────────────────────────────────────

  it("read_file: shows filePath with line range", () => {
    expect(
      summarizeToolArgs("read_file", {
        filePath: "/src/foo.ts",
        startLine: 10,
        endLine: 50,
      }),
    ).toBe("/src/foo.ts L10-L50");
  });

  it("read_file: shows filePath with startLine only", () => {
    expect(
      summarizeToolArgs("read_file", {
        filePath: "/src/foo.ts",
        startLine: 10,
      }),
    ).toBe("/src/foo.ts L10");
  });

  it("read_file: shows filePath alone when no lines", () => {
    expect(summarizeToolArgs("read_file", { filePath: "/src/foo.ts" })).toBe(
      "/src/foo.ts",
    );
  });

  it("read_file: truncates long paths", () => {
    const result = summarizeToolArgs("read_file", {
      filePath: "/very/long/path/to/some/deeply/nested/directory/file.ts",
    });
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).toContain("...");
  });

  it("read_file: strips workspace prefixes", () => {
    const result = summarizeToolArgs("read_file", {
      filePath:
        "/var/home/wycats/Code/Vercel/vscode-ai-gateway/packages/vscode-ai-gateway/src/foo.ts",
    });
    expect(result).not.toContain("/var/home");
    expect(result).toContain("src/foo.ts");
  });

  it("replace_string_in_file: shows filePath", () => {
    expect(
      summarizeToolArgs("replace_string_in_file", {
        filePath: "/src/foo.ts",
        oldString: "const x = 1;",
        newString: "const x = 2;",
      }),
    ).toBe("/src/foo.ts");
  });

  it("create_file: shows filePath", () => {
    expect(
      summarizeToolArgs("create_file", {
        filePath: "/src/new-file.ts",
        content: "export const x = 1;",
      }),
    ).toBe("/src/new-file.ts");
  });

  it("create_directory: shows dirPath", () => {
    expect(
      summarizeToolArgs("create_directory", { dirPath: "/src/utils" }),
    ).toBe("/src/utils");
  });

  it("multi_replace_string_in_file: shows replacement count", () => {
    expect(
      summarizeToolArgs("multi_replace_string_in_file", {
        replacements: [{}, {}, {}],
      }),
    ).toBe("3 replacements");
  });

  it("multi_replace_string_in_file: singular for 1 replacement", () => {
    expect(
      summarizeToolArgs("multi_replace_string_in_file", {
        replacements: [{}],
      }),
    ).toBe("1 replacement");
  });

  // ── Search tools ─────────────────────────────────────────────────

  it("grep_search: shows query", () => {
    expect(
      summarizeToolArgs("grep_search", {
        query: "formatLabel",
        isRegexp: false,
      }),
    ).toBe("formatLabel");
  });

  it("grep_search: shows query with includePattern", () => {
    expect(
      summarizeToolArgs("grep_search", {
        query: "formatLabel",
        includePattern: "src/**/*.ts",
      }),
    ).toBe("formatLabel in src/**/*.ts");
  });

  it("grep_search: truncates long queries", () => {
    const result = summarizeToolArgs("grep_search", {
      query: "a very long search query that exceeds the maximum length",
    });
    expect(result.length).toBeLessThanOrEqual(30);
    expect(result).toContain("...");
  });

  it("semantic_search: shows query", () => {
    expect(
      summarizeToolArgs("semantic_search", { query: "tool call rendering" }),
    ).toBe("tool call rendering");
  });

  it("file_search: shows query", () => {
    expect(summarizeToolArgs("file_search", { query: "*.test.ts" })).toBe(
      "*.test.ts",
    );
  });

  // ── Directory/navigation ─────────────────────────────────────────

  it("list_dir: shows path", () => {
    expect(summarizeToolArgs("list_dir", { path: "/src/conversation" })).toBe(
      "/src/conversation",
    );
  });

  // ── Terminal ─────────────────────────────────────────────────────

  it("run_in_terminal: shows command", () => {
    expect(
      summarizeToolArgs("run_in_terminal", {
        command: "pnpm test",
        explanation: "Run tests",
        goal: "Verify",
        isBackground: false,
      }),
    ).toBe("pnpm test");
  });

  it("run_in_terminal: truncates long commands", () => {
    const result = summarizeToolArgs("run_in_terminal", {
      command:
        "cd /var/home/wycats/Code/Vercel/vscode-ai-gateway && pnpm vitest run 2>&1 | tail -30",
      explanation: "Run tests",
      goal: "Verify",
      isBackground: false,
    });
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).toContain("...");
  });

  // ── Other tools ──────────────────────────────────────────────────

  it("list_code_usages: shows symbolName", () => {
    expect(
      summarizeToolArgs("list_code_usages", { symbolName: "formatLabel" }),
    ).toBe("formatLabel");
  });

  it("get_errors: shows file count", () => {
    expect(
      summarizeToolArgs("get_errors", {
        filePaths: ["/src/a.ts", "/src/b.ts"],
      }),
    ).toBe("2 files");
  });

  it("get_errors: shows 'all files' when no paths", () => {
    expect(summarizeToolArgs("get_errors", {})).toBe("all files");
  });

  it("fetch_webpage: shows hostname", () => {
    expect(
      summarizeToolArgs("fetch_webpage", {
        urls: ["https://example.com/page"],
        query: "test",
      }),
    ).toBe("example.com");
  });

  it("runSubagent: shows description", () => {
    expect(
      summarizeToolArgs("runSubagent", {
        description: "Audit codebase",
        prompt: "...",
      }),
    ).toBe("Audit codebase");
  });

  it("runSubagent: falls back to agentName", () => {
    expect(
      summarizeToolArgs("runSubagent", {
        agentName: "recon",
        prompt: "...",
      }),
    ).toBe("recon");
  });

  // ── Fallback ─────────────────────────────────────────────────────

  it("unknown tool: shows first 2 arg values", () => {
    expect(
      summarizeToolArgs("custom_tool", { a: "hello", b: "world", c: "extra" }),
    ).toBe("hello, world");
  });

  it("unknown tool: truncates long values", () => {
    const result = summarizeToolArgs("custom_tool", {
      a: "a very long string that exceeds the truncation limit",
    });
    expect(result.length).toBeLessThanOrEqual(30);
    expect(result).toContain("...");
  });

  it("unknown tool: returns empty string for empty args", () => {
    expect(summarizeToolArgs("custom_tool", {})).toBe("");
  });

  it("known tool with missing expected args: falls back to generic", () => {
    // read_file without filePath
    const result = summarizeToolArgs("read_file", { unexpected: "value" });
    expect(result).toBe("value");
  });
});

describe("toolIcon", () => {
  it("returns go-to-file for read_file", () => {
    expect(toolIcon("read_file")).toBe("go-to-file");
  });

  it("returns edit for replace_string_in_file", () => {
    expect(toolIcon("replace_string_in_file")).toBe("edit");
  });

  it("returns search for grep_search", () => {
    expect(toolIcon("grep_search")).toBe("search");
  });

  it("returns terminal for run_in_terminal", () => {
    expect(toolIcon("run_in_terminal")).toBe("terminal");
  });

  it("returns folder-opened for list_dir", () => {
    expect(toolIcon("list_dir")).toBe("folder-opened");
  });

  it("returns new-file for create_file", () => {
    expect(toolIcon("create_file")).toBe("new-file");
  });

  it("returns warning for get_errors", () => {
    expect(toolIcon("get_errors")).toBe("warning");
  });

  it("returns wrench for unknown tools", () => {
    expect(toolIcon("some_unknown_tool")).toBe("wrench");
  });

  it("returns rocket for runSubagent", () => {
    expect(toolIcon("runSubagent")).toBe("rocket");
  });

  it("returns globe for fetch_webpage", () => {
    expect(toolIcon("fetch_webpage")).toBe("globe");
  });
});
