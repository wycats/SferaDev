import type { Uri } from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Hoisted mocks
// ─────────────────────────────────────────────────────────────────────────────

const hoisted = vi.hoisted(() => {
  const mockMkdir = vi.fn().mockResolvedValue(undefined);
  const mockWriteFile = vi.fn().mockResolvedValue(undefined);
  const mockAppendFile = vi.fn().mockResolvedValue(undefined);

  // Logger mock
  const mockLoggerInfo = vi.fn();
  const mockLoggerError = vi.fn();

  return {
    mockMkdir,
    mockWriteFile,
    mockAppendFile,
    mockLoggerInfo,
    mockLoggerError,
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

// Mock vscode
vi.mock("vscode", () => ({
  Uri: {
    file: (p: string) => ({ fsPath: p }),
  },
}));

// Mock logger
vi.mock("../logger.js", () => ({
  logger: {
    info: hoisted.mockLoggerInfo,
    error: hoisted.mockLoggerError,
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

// Import after mocking
import {
  ErrorCaptureLogger,
  writeError,
  type ErrorCapture,
  type ErrorCaptureData,
  type ErrorIndexEntry,
} from "./error-capture.js";
import type { SSEEventEntry } from "./investigation.js";

// Type-safe JSON parse helpers to avoid unsafe-any lint errors
function parseCapture(text: string): ErrorCapture {
  return JSON.parse(text) as ErrorCapture;
}
function parseIndex(text: string): ErrorIndexEntry {
  return JSON.parse(text) as ErrorIndexEntry;
}
function parseSSE(text: string): SSEEventEntry {
  return JSON.parse(text) as SSEEventEntry;
}

// Mock Uri constructor to avoid `as any` lint errors
function mockUri(fsPath: string): Uri {
  return { fsPath } as unknown as Uri;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeErrorCaptureData(
  overrides: Partial<ErrorCaptureData> = {},
): ErrorCaptureData {
  return {
    chatId: "chat-123",
    conversationId: "conv-456",
    errorType: "no-response",
    errorMessage: "No response received from model",
    model: "gpt-4o",
    estimatedInputTokens: 1000,
    messageCount: 3,
    messageRoles: "system,user,assistant",
    toolCount: 0,
    toolNames: [],
    isSummarization: false,
    requestBody: {
      model: "gpt-4o",
      input: [{ role: "user", content: "Hello" }],
      instructions: "Be helpful",
    },
    eventCount: 5,
    textPartCount: 0,
    toolCallCount: 0,
    responseId: undefined,
    finishReason: undefined,
    usage: null,
    requestStartMs: 1000,
    ttftMs: null,
    durationMs: 5000,
    ...overrides,
  };
}

function makeSSEBuffer(count = 3): SSEEventEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    seq: i + 1,
    ts: new Date(Date.now() + i * 100).toISOString(),
    elapsed: i * 100,
    type: "response.output_text.delta",
    payload: { type: "response.output_text.delta", delta: `chunk${i}` },
  }));
}

function makeErrorCapture(overrides: Partial<ErrorCapture> = {}): ErrorCapture {
  return {
    ts: "2026-02-10T12:00:00.000Z",
    chatId: "chat-123",
    conversationId: "conv-456",
    errorType: "no-response",
    errorMessage: "No response received from model",
    request: {
      model: "gpt-4o",
      estimatedInputTokens: 1000,
      messageCount: 3,
      messageRoles: "system,user,assistant",
      toolCount: 0,
      toolNames: [],
      isSummarization: false,
      body: {
        model: "gpt-4o",
        input: [{ role: "user", content: "Hello" }],
        instructions: "Be helpful",
        tools: undefined,
        toolChoice: undefined,
        temperature: undefined,
        maxOutputTokens: undefined,
        promptCacheKey: undefined,
        caching: undefined,
      },
    },
    response: {
      eventCount: 5,
      textPartCount: 0,
      toolCallCount: 0,
      responseId: undefined,
      finishReason: undefined,
      usage: null,
    },
    timing: {
      requestStartMs: 1000,
      ttftMs: null,
      durationMs: 5000,
    },
    sseEventCount: 0,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests: writeError
// ─────────────────────────────────────────────────────────────────────────────

describe("writeError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates date directory and writes index + capture JSON", async () => {
    const capture = makeErrorCapture();
    await writeError("/storage/errors", capture, []);

    // Should create date directory
    expect(hoisted.mockMkdir).toHaveBeenCalledWith(
      "/storage/errors/2026-02-10",
      { recursive: true },
    );

    // Should append to index.jsonl
    expect(hoisted.mockAppendFile).toHaveBeenCalledOnce();
    const [indexPath, indexContent] = hoisted.mockAppendFile.mock.calls[0] as [
      string,
      string,
    ];
    expect(indexPath).toBe("/storage/errors/index.jsonl");
    const indexEntry = parseIndex(indexContent.trim());
    expect(indexEntry.chatId).toBe("chat-123");
    expect(indexEntry.errorType).toBe("no-response");
    expect(indexEntry.model).toBe("gpt-4o");
    expect(indexEntry.durationMs).toBe(5000);

    // Should write capture JSON
    expect(hoisted.mockWriteFile).toHaveBeenCalledOnce();
    const [capturePath, captureContent] = hoisted.mockWriteFile.mock
      .calls[0] as [string, string];
    expect(capturePath).toBe("/storage/errors/2026-02-10/chat-123.json");
    const parsed = parseCapture(captureContent);
    expect(parsed.errorType).toBe("no-response");
    expect(parsed.request.model).toBe("gpt-4o");
    expect(parsed.timing.durationMs).toBe(5000);
  });

  it("writes SSE buffer when events are present", async () => {
    const capture = makeErrorCapture({ sseEventCount: 3 });
    const sseBuffer = makeSSEBuffer(3);

    await writeError("/storage/errors", capture, sseBuffer);

    // Should write 2 files: capture JSON + SSE JSONL
    expect(hoisted.mockWriteFile).toHaveBeenCalledTimes(2);

    const sseCalls = hoisted.mockWriteFile.mock.calls.filter((c: unknown[]) =>
      (c[0] as string).endsWith(".sse.jsonl"),
    );
    expect(sseCalls).toHaveLength(1);
    const [ssePath, sseContent] = sseCalls[0] as [string, string];
    expect(ssePath).toBe("/storage/errors/2026-02-10/chat-123.sse.jsonl");
    const lines = sseContent.trim().split("\n");
    expect(lines).toHaveLength(3);
    const firstLine = lines[0] ?? "";
    expect(parseSSE(firstLine).type).toBe("response.output_text.delta");
  });

  it("skips SSE file when buffer is empty", async () => {
    const capture = makeErrorCapture();
    await writeError("/storage/errors", capture, []);

    // Only capture JSON, no SSE file
    expect(hoisted.mockWriteFile).toHaveBeenCalledOnce();
    expect((hoisted.mockWriteFile.mock.calls[0] as [string])[0]).toBe(
      "/storage/errors/2026-02-10/chat-123.json",
    );
  });

  it("sanitizes chatId for filesystem safety", async () => {
    const capture = makeErrorCapture({ chatId: "chat/with\\bad:chars" });
    await writeError("/storage/errors", capture, []);

    const capturePath = (hoisted.mockWriteFile.mock.calls[0] as [string])[0];
    // sanitizePathSegment replaces unsafe chars
    expect(capturePath).not.toContain("/bad");
    expect(capturePath).not.toContain("\\bad");
  });

  it("includes all index entry fields", async () => {
    const capture = makeErrorCapture({
      conversationId: "conv-789",
      request: {
        ...makeErrorCapture().request,
        isSummarization: true,
      },
      response: {
        eventCount: 10,
        textPartCount: 2,
        toolCallCount: 1,
        responseId: "resp-abc",
        finishReason: "stop",
        usage: { input_tokens: 500, output_tokens: 100 },
      },
    });

    await writeError("/storage/errors", capture, []);

    const indexContent = (
      hoisted.mockAppendFile.mock.calls[0] as [string, string]
    )[1];
    const entry = parseIndex(indexContent.trim());
    expect(entry.conversationId).toBe("conv-789");
    expect(entry.isSummarization).toBe(true);
    expect(entry.eventCount).toBe(10);
    expect(entry.textPartCount).toBe(2);
    expect(entry.toolCallCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: ErrorCaptureLogger
// ─────────────────────────────────────────────────────────────────────────────

describe("ErrorCaptureLogger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-10T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("constructs with correct errors directory", () => {
    const logger = new ErrorCaptureLogger(mockUri("/global-storage"));
    expect(logger.getErrorsDir()).toBe("/global-storage/errors");
  });

  it("captures error and writes to disk", async () => {
    const errorLogger = new ErrorCaptureLogger(mockUri("/global-storage"));
    const data = makeErrorCaptureData();
    const sseBuffer = makeSSEBuffer(2);

    await errorLogger.captureError(data, sseBuffer);

    // Should have created directory
    expect(hoisted.mockMkdir).toHaveBeenCalledWith(
      "/global-storage/errors/2026-02-10",
      { recursive: true },
    );

    // Should have appended to index
    expect(hoisted.mockAppendFile).toHaveBeenCalledOnce();

    // Should have written capture JSON + SSE JSONL
    expect(hoisted.mockWriteFile).toHaveBeenCalledTimes(2);

    // Should log success
    expect(hoisted.mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("[ErrorCapture]"),
    );
  });

  it("builds capture with correct structure", async () => {
    const errorLogger = new ErrorCaptureLogger(mockUri("/global-storage"));
    const data = makeErrorCaptureData({
      responseId: "resp-xyz",
      finishReason: "stop",
      usage: { input_tokens: 500, output_tokens: 200 },
      ttftMs: 150,
    });

    await errorLogger.captureError(data, []);

    const captureContent = (
      hoisted.mockWriteFile.mock.calls[0] as [string, string]
    )[1];
    const capture = parseCapture(captureContent);

    expect(capture.ts).toBe("2026-02-10T12:00:00.000Z");
    expect(capture.chatId).toBe("chat-123");
    expect(capture.errorType).toBe("no-response");
    expect(capture.request.model).toBe("gpt-4o");
    expect(capture.request.body.instructions).toBe("Be helpful");
    expect(capture.response.responseId).toBe("resp-xyz");
    expect(capture.response.usage?.input_tokens).toBe(500);
    expect(capture.timing.ttftMs).toBe(150);
    expect(capture.timing.durationMs).toBe(5000);
    expect(capture.sseEventCount).toBe(0);
  });

  it("handles write errors gracefully (fire-and-forget)", async () => {
    hoisted.mockMkdir.mockRejectedValueOnce(new Error("ENOSPC"));

    const errorLogger = new ErrorCaptureLogger(mockUri("/global-storage"));
    const data = makeErrorCaptureData();

    // Should not throw
    await errorLogger.captureError(data, []);

    // Should log the error
    expect(hoisted.mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("ENOSPC"),
    );
  });

  it("handles non-Error throw gracefully", async () => {
    hoisted.mockMkdir.mockRejectedValueOnce("string error");

    const errorLogger = new ErrorCaptureLogger(mockUri("/global-storage"));

    await errorLogger.captureError(makeErrorCaptureData(), []);

    expect(hoisted.mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("Unknown error"),
    );
  });

  it("maps requestBody fields correctly", async () => {
    const errorLogger = new ErrorCaptureLogger(mockUri("/global-storage"));
    const data = makeErrorCaptureData({
      requestBody: {
        model: "claude-sonnet-4-20250514",
        input: [],
        instructions: null,
        tools: [{ type: "function", name: "search" }],
        tool_choice: "auto",
        temperature: 0.7,
        max_output_tokens: 4096,
        prompt_cache_key: "key-123",
        caching: "auto",
      },
    });

    await errorLogger.captureError(data, []);

    const captureContent = (
      hoisted.mockWriteFile.mock.calls[0] as [string, string]
    )[1];
    const capture = parseCapture(captureContent);

    expect(capture.request.body.model).toBe("claude-sonnet-4-20250514");
    expect(capture.request.body.instructions).toBeNull();
    expect(capture.request.body.tools).toHaveLength(1);
    expect(capture.request.body.toolChoice).toBe("auto");
    expect(capture.request.body.temperature).toBe(0.7);
    expect(capture.request.body.maxOutputTokens).toBe(4096);
    expect(capture.request.body.promptCacheKey).toBe("key-123");
    expect(capture.request.body.caching).toBe("auto");
  });

  it("captures summarization requests", async () => {
    const errorLogger = new ErrorCaptureLogger(mockUri("/global-storage"));
    const data = makeErrorCaptureData({ isSummarization: true });

    await errorLogger.captureError(data, []);

    const indexContent = (
      hoisted.mockAppendFile.mock.calls[0] as [string, string]
    )[1];
    const entry = parseIndex(indexContent.trim());
    expect(entry.isSummarization).toBe(true);
  });
});
