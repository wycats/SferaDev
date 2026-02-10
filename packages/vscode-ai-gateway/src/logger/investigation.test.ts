import { beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Hoisted mocks
// ─────────────────────────────────────────────────────────────────────────────

const hoisted = vi.hoisted(() => {
  const mockMkdir = vi.fn().mockResolvedValue(undefined);
  const mockWriteFile = vi.fn().mockResolvedValue(undefined);
  const mockAppendFile = vi.fn().mockResolvedValue(undefined);
  const mockShowInformationMessage = vi.fn();
  const mockShowErrorMessage = vi.fn();
  const mockGetConfiguration = vi.fn();
  const mockExec = vi.fn();

  // Logger mock
  const mockLoggerError = vi.fn();
  const mockLoggerWarn = vi.fn();

  return {
    mockMkdir,
    mockWriteFile,
    mockAppendFile,
    mockShowInformationMessage,
    mockShowErrorMessage,
    mockGetConfiguration,
    mockExec,
    mockLoggerError,
    mockLoggerWarn,
  };
});

// Mock node:fs
vi.mock("node:fs", () => ({
  promises: {
    mkdir: hoisted.mockMkdir,
    writeFile: hoisted.mockWriteFile,
    appendFile: hoisted.mockAppendFile,
  },
}));

// Mock node:child_process
vi.mock("node:child_process", () => ({
  exec: hoisted.mockExec,
}));

// Mock vscode
vi.mock("vscode", () => ({
  window: {
    showInformationMessage: hoisted.mockShowInformationMessage,
    showErrorMessage: hoisted.mockShowErrorMessage,
  },
  workspace: {
    getConfiguration: hoisted.mockGetConfiguration,
    workspaceFolders: [
      {
        uri: { fsPath: "/workspace" },
      },
    ],
  },
}));

// Mock logger
vi.mock("../logger.js", () => ({
  logger: {
    error: hoisted.mockLoggerError,
    warn: hoisted.mockLoggerWarn,
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

// Import after mocking
import {
  InvestigationLogger,
  checkGitignoreWarning,
  sanitizePathSegment,
  type StartRequestData,
  type CompleteRequestData,
} from "./investigation.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeStartData(
  overrides: Partial<StartRequestData> = {},
): StartRequestData {
  return {
    conversationId: "conv-123",
    chatId: "chat-abc-1234",
    model: "anthropic/claude-sonnet-4",
    estimatedInputTokens: 5000,
    messageCount: 4,
    messageRoles: "User,Assistant,User,Assistant",
    toolCount: 2,
    toolNames: ["read_file", "write_file"],
    isSummarization: false,
    requestBody: {
      model: "anthropic/claude-sonnet-4",
      input: [{ role: "user", content: "Hello" }],
      instructions: "You are a helpful assistant.",
      tools: [{ type: "function", function: { name: "read_file" } }],
      tool_choice: "auto",
      temperature: 0.1,
      max_output_tokens: 16384,
      prompt_cache_key: "conv-123",
      caching: "auto",
    },
    ...overrides,
  };
}

function makeCompleteData(
  overrides: Partial<CompleteRequestData> = {},
): CompleteRequestData {
  return {
    status: "success",
    finishReason: "stop",
    responseId: "resp-xyz",
    error: null,
    durationMs: 2500,
    ttftMs: 800,
    eventCount: 42,
    textPartCount: 15,
    toolCallCount: 1,
    usage: {
      input_tokens: 4800,
      output_tokens: 350,
      cache_read_input_tokens: 1200,
    },
    ...overrides,
  };
}

/** Configure mock to return investigation settings. */
function mockConfig(name: string, detail: string, logDir = ".logs") {
  hoisted.mockGetConfiguration.mockImplementation((section: string) => {
    if (section === "vercel.ai") {
      return {
        get: (key: string, defaultValue?: unknown) => {
          if (key === "investigation.name") return name;
          if (key === "investigation.detail") return detail;
          if (key === "logging.fileDirectory") return logDir;
          return defaultValue;
        },
      };
    }
    return { get: () => undefined };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("InvestigationLogger", () => {
  let investigationLogger: InvestigationLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    investigationLogger = new InvestigationLogger();
  });

  describe("detail=off", () => {
    it("startRequest returns null when detail is off", () => {
      mockConfig("default", "off");
      const handle = investigationLogger.startRequest(makeStartData());
      expect(handle).toBeNull();
    });
  });

  describe("detail=index", () => {
    beforeEach(() => {
      mockConfig("default", "index");
    });

    it("startRequest returns handle with null recorder (no SSE at index level)", () => {
      const handle = investigationLogger.startRequest(makeStartData());
      expect(handle).not.toBeNull();
      expect(handle!.recorder).toBeNull();
    });

    it("writes only index.jsonl", async () => {
      const handle = investigationLogger.startRequest(makeStartData());
      expect(handle).not.toBeNull();
      await handle!.complete(makeCompleteData());

      // Should create investigation directory
      expect(hoisted.mockMkdir).toHaveBeenCalledWith(
        "/workspace/.logs/default",
        { recursive: true },
      );

      // Should write index entry
      expect(hoisted.mockAppendFile).toHaveBeenCalledTimes(1);
      const [filePath, content] = hoisted.mockAppendFile.mock.calls[0] as [
        string,
        string,
        string,
      ];
      expect(filePath).toBe("/workspace/.logs/default/index.jsonl");

      const entry = JSON.parse(content.trim());
      expect(entry.conversationId).toBe("conv-123");
      expect(entry.chatId).toBe("chat-abc-1234");
      expect(entry.model).toBe("anthropic/claude-sonnet-4");
      expect(entry.status).toBe("success");
      expect(entry.messageCount).toBe(4);
      expect(entry.toolCount).toBe(2);
      expect(entry.estimatedInputTokens).toBe(5000);
      expect(entry.actualInputTokens).toBe(4800);
      expect(entry.actualOutputTokens).toBe(350);
      expect(entry.cachedTokens).toBe(1200);
      expect(entry.isSummarization).toBe(false);

      // Should NOT create messages directory or write per-chat files
      expect(hoisted.mockWriteFile).not.toHaveBeenCalled();
    });

    it("computes token delta correctly", async () => {
      const handle = investigationLogger.startRequest(
        makeStartData({ estimatedInputTokens: 5000 }),
      );
      await handle!.complete(
        makeCompleteData({ usage: { input_tokens: 5500, output_tokens: 200 } }),
      );

      const content = hoisted.mockAppendFile.mock.calls[0]![1] as string;
      const entry = JSON.parse(content.trim());
      expect(entry.tokenDelta).toBe(-500); // 5000 - 5500
      expect(entry.tokenDeltaPct).toBeCloseTo(-9.09, 1); // -500/5500 * 100
    });

    it("handles null usage gracefully", async () => {
      const handle = investigationLogger.startRequest(makeStartData());
      await handle!.complete(makeCompleteData({ usage: null }));

      const content = hoisted.mockAppendFile.mock.calls[0]![1] as string;
      const entry = JSON.parse(content.trim());
      expect(entry.actualInputTokens).toBeNull();
      expect(entry.actualOutputTokens).toBeNull();
      expect(entry.tokenDelta).toBeNull();
      expect(entry.tokenDeltaPct).toBeNull();
    });
  });

  describe("detail=messages", () => {
    beforeEach(() => {
      mockConfig("default", "messages");
    });

    it("writes index + messages.jsonl + per-chat JSON", async () => {
      const handle = investigationLogger.startRequest(makeStartData());
      await handle!.complete(makeCompleteData());

      // Creates investigation dir + messages dir
      expect(hoisted.mockMkdir).toHaveBeenCalledWith(
        "/workspace/.logs/default",
        { recursive: true },
      );
      expect(hoisted.mockMkdir).toHaveBeenCalledWith(
        "/workspace/.logs/default/conv-123/messages",
        { recursive: true },
      );

      // index.jsonl + messages.jsonl
      expect(hoisted.mockAppendFile).toHaveBeenCalledTimes(2);

      const indexCall = hoisted.mockAppendFile.mock.calls[0] as [
        string,
        string,
        string,
      ];
      expect(indexCall[0]).toBe("/workspace/.logs/default/index.jsonl");

      const messagesCall = hoisted.mockAppendFile.mock.calls[1] as [
        string,
        string,
        string,
      ];
      expect(messagesCall[0]).toBe(
        "/workspace/.logs/default/conv-123/messages.jsonl",
      );
      const msgEntry = JSON.parse((messagesCall[1] as string).trim());
      expect(msgEntry.messageRoles).toBe("User,Assistant,User,Assistant");
      expect(msgEntry.toolNames).toEqual(["read_file", "write_file"]);
      expect(msgEntry.systemPromptLength).toBe(
        "You are a helpful assistant.".length,
      );

      // Full capture JSON
      expect(hoisted.mockWriteFile).toHaveBeenCalledTimes(1);
      const writeCall = hoisted.mockWriteFile.mock.calls[0] as [
        string,
        string,
        string,
      ];
      expect(writeCall[0]).toBe(
        "/workspace/.logs/default/conv-123/messages/chat-abc-1234.json",
      );
      const capture = JSON.parse(writeCall[1] as string);
      expect(capture.request.model).toBe("anthropic/claude-sonnet-4");
      expect(capture.request.instructions).toBe("You are a helpful assistant.");
      expect(capture.response.status).toBe("success");
      expect(capture.isSummarization).toBe(false);
    });

    it("does NOT write SSE events at messages level", async () => {
      const handle = investigationLogger.startRequest(makeStartData());
      await handle!.complete(makeCompleteData());

      // Only one writeFile call (the full capture JSON), no SSE file
      expect(hoisted.mockWriteFile).toHaveBeenCalledTimes(1);
      const writeCall = hoisted.mockWriteFile.mock.calls[0] as [
        string,
        string,
        string,
      ];
      expect(writeCall[0]).not.toContain(".sse.jsonl");
    });
  });

  describe("detail=full", () => {
    beforeEach(() => {
      mockConfig("default", "full");
    });

    it("startRequest returns handle with SSE recorder", () => {
      const handle = investigationLogger.startRequest(makeStartData());
      expect(handle).not.toBeNull();
      expect(handle!.recorder).not.toBeNull();
      expect(typeof handle!.recorder!.recordEvent).toBe("function");
    });

    it("writes all files including SSE events", async () => {
      const handle = investigationLogger.startRequest(makeStartData());
      expect(handle).not.toBeNull();

      // Record some SSE events
      handle!.recorder!.recordEvent(1, "response.created", { id: "resp-1" });
      handle!.recorder!.recordEvent(2, "response.output_text.delta", {
        delta: "Hello",
      });
      handle!.recorder!.recordEvent(3, "response.completed", { id: "resp-1" });

      await handle!.complete(makeCompleteData());

      // index.jsonl + messages.jsonl
      expect(hoisted.mockAppendFile).toHaveBeenCalledTimes(2);

      // Full capture JSON + SSE JSONL
      expect(hoisted.mockWriteFile).toHaveBeenCalledTimes(2);

      const sseCall = hoisted.mockWriteFile.mock.calls[1] as [
        string,
        string,
        string,
      ];
      expect(sseCall[0]).toBe(
        "/workspace/.logs/default/conv-123/messages/chat-abc-1234.sse.jsonl",
      );

      const sseLines = (sseCall[1] as string).trim().split("\n");
      expect(sseLines).toHaveLength(3);

      const event1 = JSON.parse(sseLines[0]!);
      expect(event1.seq).toBe(1);
      expect(event1.type).toBe("response.created");
      expect(event1.payload).toEqual({ id: "resp-1" });
      expect(typeof event1.elapsed).toBe("number");
      expect(typeof event1.ts).toBe("string");

      const event2 = JSON.parse(sseLines[1]!);
      expect(event2.seq).toBe(2);
      expect(event2.type).toBe("response.output_text.delta");
    });

    it("does not write SSE file when no events recorded", async () => {
      const handle = investigationLogger.startRequest(makeStartData());
      // Don't record any events
      await handle!.complete(makeCompleteData());

      // Only full capture JSON, no SSE file
      expect(hoisted.mockWriteFile).toHaveBeenCalledTimes(1);
      const writeCall = hoisted.mockWriteFile.mock.calls[0] as [
        string,
        string,
        string,
      ];
      expect(writeCall[0]).not.toContain(".sse.jsonl");
    });
  });

  describe("investigation name scoping", () => {
    it("uses configured investigation name in file paths", async () => {
      mockConfig("my-investigation", "index");
      const handle = investigationLogger.startRequest(makeStartData());
      await handle!.complete(makeCompleteData());

      expect(hoisted.mockMkdir).toHaveBeenCalledWith(
        "/workspace/.logs/my-investigation",
        { recursive: true },
      );
      expect(hoisted.mockAppendFile).toHaveBeenCalledWith(
        "/workspace/.logs/my-investigation/index.jsonl",
        expect.any(String),
        "utf8",
      );
    });

    it("uses default name when not configured", async () => {
      mockConfig("default", "index");
      const handle = investigationLogger.startRequest(makeStartData());
      await handle!.complete(makeCompleteData());

      expect(hoisted.mockMkdir).toHaveBeenCalledWith(
        "/workspace/.logs/default",
        { recursive: true },
      );
    });
  });

  describe("concurrent requests", () => {
    it("handles overlapping requests independently", async () => {
      mockConfig("default", "index");

      const handle1 = investigationLogger.startRequest(
        makeStartData({ chatId: "chat-1", conversationId: "conv-1" }),
      );
      const handle2 = investigationLogger.startRequest(
        makeStartData({ chatId: "chat-2", conversationId: "conv-2" }),
      );

      // Complete in reverse order
      await handle2!.complete(makeCompleteData({ responseId: "resp-2" }));
      await handle1!.complete(makeCompleteData({ responseId: "resp-1" }));

      expect(hoisted.mockAppendFile).toHaveBeenCalledTimes(2);

      const entry1 = JSON.parse(
        (hoisted.mockAppendFile.mock.calls[0]![1] as string).trim(),
      );
      const entry2 = JSON.parse(
        (hoisted.mockAppendFile.mock.calls[1]![1] as string).trim(),
      );

      // handle2 completed first
      expect(entry1.chatId).toBe("chat-2");
      expect(entry1.responseId).toBe("resp-2");

      // handle1 completed second
      expect(entry2.chatId).toBe("chat-1");
      expect(entry2.responseId).toBe("resp-1");
    });
  });

  describe("detail snapshot at start", () => {
    it("uses detail level from startRequest, not completeRequest", async () => {
      // Start at messages level
      mockConfig("default", "messages");
      const handle = investigationLogger.startRequest(makeStartData());

      // Switch to off before completing
      mockConfig("default", "off");
      await handle!.complete(makeCompleteData());

      // Should still write at messages level (snapshotted at start)
      expect(hoisted.mockAppendFile).toHaveBeenCalledTimes(2); // index + messages
      expect(hoisted.mockWriteFile).toHaveBeenCalledTimes(1); // full capture
    });
  });

  describe("error handling", () => {
    it("logs to Output Channel and shows toast on IO failure", async () => {
      mockConfig("default", "index");
      hoisted.mockMkdir.mockRejectedValueOnce(new Error("Permission denied"));

      const handle = investigationLogger.startRequest(makeStartData());
      await handle!.complete(makeCompleteData());

      expect(hoisted.mockLoggerError).toHaveBeenCalledWith(
        expect.stringContaining("Permission denied"),
      );
      expect(hoisted.mockShowErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Permission denied"),
      );
    });

    it("never throws even on IO failure", async () => {
      mockConfig("default", "messages");
      hoisted.mockMkdir.mockRejectedValueOnce(new Error("Disk full"));

      const handle = investigationLogger.startRequest(makeStartData());
      // Should not throw
      await expect(
        handle!.complete(makeCompleteData()),
      ).resolves.toBeUndefined();
    });
  });

  describe("summarization flag", () => {
    it("records isSummarization in index entry", async () => {
      mockConfig("default", "index");
      const handle = investigationLogger.startRequest(
        makeStartData({ isSummarization: true }),
      );
      await handle!.complete(makeCompleteData());

      const content = hoisted.mockAppendFile.mock.calls[0]![1] as string;
      const entry = JSON.parse(content.trim());
      expect(entry.isSummarization).toBe(true);
    });
  });

  describe("error and timeout status", () => {
    it("records error status with error message", async () => {
      mockConfig("default", "messages");
      const handle = investigationLogger.startRequest(makeStartData());
      await handle!.complete(
        makeCompleteData({
          status: "error",
          error: "Model returned 500",
          finishReason: null,
        }),
      );

      // Check index entry
      const indexContent = hoisted.mockAppendFile.mock.calls[0]![1] as string;
      const indexEntry = JSON.parse(indexContent.trim());
      expect(indexEntry.status).toBe("error");

      // Check message summary
      const msgContent = hoisted.mockAppendFile.mock.calls[1]![1] as string;
      const msgEntry = JSON.parse(msgContent.trim());
      expect(msgEntry.error).toBe("Model returned 500");
      expect(msgEntry.status).toBe("error");
    });

    it("records timeout status", async () => {
      mockConfig("default", "index");
      const handle = investigationLogger.startRequest(makeStartData());
      await handle!.complete(makeCompleteData({ status: "timeout" }));

      const content = hoisted.mockAppendFile.mock.calls[0]![1] as string;
      const entry = JSON.parse(content.trim());
      expect(entry.status).toBe("timeout");
    });
  });
});

describe("sanitizePathSegment", () => {
  it("returns clean strings unchanged", () => {
    expect(sanitizePathSegment("conv-123")).toBe("conv-123");
    expect(sanitizePathSegment("chat_abc_1234")).toBe("chat_abc_1234");
  });

  it("replaces forward slashes with underscore", () => {
    expect(sanitizePathSegment("foo/bar")).toBe("foo_bar");
    expect(sanitizePathSegment("/leading")).toBe("leading"); // trimmed
  });

  it("replaces backslashes with underscore", () => {
    expect(sanitizePathSegment("foo\\bar")).toBe("foo_bar");
  });

  it("neutralizes path traversals", () => {
    expect(sanitizePathSegment("..")).toBe("unknown"); // ".." → "_" → trimmed → "" → "unknown"
    expect(sanitizePathSegment("../etc/passwd")).toBe("etc_passwd");
    expect(sanitizePathSegment("foo/../bar")).toBe("foo_bar");
  });

  it("replaces control characters", () => {
    expect(sanitizePathSegment("foo\x00bar")).toBe("foo_bar");
    expect(sanitizePathSegment("foo\nbar")).toBe("foo_bar");
    expect(sanitizePathSegment("foo\tbar")).toBe("foo_bar");
  });

  it("returns 'unknown' for empty result", () => {
    expect(sanitizePathSegment("")).toBe("unknown");
    expect(sanitizePathSegment("..")).toBe("unknown");
    expect(sanitizePathSegment("///")).toBe("unknown");
  });

  it("replaces filesystem-unsafe characters", () => {
    expect(sanitizePathSegment("foo:bar")).toBe("foo_bar");
    expect(sanitizePathSegment("foo*bar")).toBe("foo_bar");
    expect(sanitizePathSegment("foo?bar")).toBe("foo_bar");
    expect(sanitizePathSegment('foo"bar')).toBe("foo_bar");
    expect(sanitizePathSegment("foo<bar>baz")).toBe("foo_bar_baz");
    expect(sanitizePathSegment("foo|bar")).toBe("foo_bar");
  });
});

describe("checkGitignoreWarning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the warned directories set by requiring a fresh module
    // Since we can't easily reset module state, we test with unique paths
  });

  it("shows warning when in git repo but not gitignored", async () => {
    // Mock exec for git commands
    hoisted.mockExec.mockImplementation(
      (
        cmd: string,
        _opts: unknown,
        cb: (err: Error | null, stdout?: string) => void,
      ) => {
        if (cmd === "git rev-parse --git-dir") {
          cb(null, ".git");
        } else if (cmd === "git rev-parse --show-toplevel") {
          cb(null, "/workspace");
        } else if (cmd.startsWith("git check-ignore")) {
          // exit code 1 = not ignored
          cb(new Error("not ignored"));
        }
      },
    );

    await checkGitignoreWarning("/workspace/.logs/test-warn-1");

    expect(hoisted.mockShowInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("Consider adding"),
    );
  });

  it("does not warn when directory is gitignored", async () => {
    hoisted.mockExec.mockImplementation(
      (
        cmd: string,
        _opts: unknown,
        cb: (err: Error | null, stdout?: string) => void,
      ) => {
        if (cmd === "git rev-parse --git-dir") {
          cb(null, ".git");
        } else if (cmd === "git rev-parse --show-toplevel") {
          cb(null, "/workspace");
        } else if (cmd.startsWith("git check-ignore")) {
          // exit code 0 = ignored
          cb(null);
        }
      },
    );

    await checkGitignoreWarning("/workspace/.logs/test-warn-2");

    expect(hoisted.mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it("does not warn when not in a git repo", async () => {
    hoisted.mockExec.mockImplementation(
      (
        cmd: string,
        _opts: unknown,
        cb: (err: Error | null, stdout?: string) => void,
      ) => {
        if (cmd === "git rev-parse --git-dir") {
          cb(new Error("not a git repo"));
        }
      },
    );

    await checkGitignoreWarning("/workspace/.logs/test-warn-3");

    expect(hoisted.mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it("only warns once per session per directory", async () => {
    hoisted.mockExec.mockImplementation(
      (
        cmd: string,
        _opts: unknown,
        cb: (err: Error | null, stdout?: string) => void,
      ) => {
        if (cmd === "git rev-parse --git-dir") {
          cb(null, ".git");
        } else if (cmd === "git rev-parse --show-toplevel") {
          cb(null, "/workspace");
        } else if (cmd.startsWith("git check-ignore")) {
          cb(new Error("not ignored"));
        }
      },
    );

    const dir = "/workspace/.logs/test-warn-once";
    await checkGitignoreWarning(dir);
    await checkGitignoreWarning(dir);

    // Only called once despite two invocations
    expect(hoisted.mockShowInformationMessage).toHaveBeenCalledTimes(1);
  });

  it("swallows errors silently", async () => {
    hoisted.mockExec.mockImplementation(() => {
      throw new Error("exec failed");
    });

    // Should not throw
    await expect(
      checkGitignoreWarning("/workspace/.logs/test-warn-error"),
    ).resolves.toBeUndefined();
  });
});
