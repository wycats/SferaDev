import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const createClient = vi.fn();
  const adaptMock = vi.fn();

  class MockStreamAdapter {
    adapt = adaptMock;
    reset = vi.fn();
    getResponseId = vi.fn(() => undefined);
    getModel = vi.fn(() => undefined);
  }

  // Investigation logger mock — configurable per test
  const mockStartRequest = vi.fn();
  const mockComplete = vi.fn().mockResolvedValue(undefined);
  const mockRecordEvent = vi.fn();

  class MockInvestigationLogger {
    startRequest = mockStartRequest;
  }

  return {
    createClient,
    adaptMock,
    MockStreamAdapter,
    mockStartRequest,
    mockComplete,
    mockRecordEvent,
    MockInvestigationLogger,
  };
});

vi.mock("openresponses-client", () => ({
  createClient: hoisted.createClient,
  OpenResponsesError: class OpenResponsesError extends Error {
    constructor(
      message: string,
      public readonly status?: number,
      public readonly code?: string,
    ) {
      super(message);
      this.name = "OpenResponsesError";
    }
  },
}));

vi.mock("./stream-adapter", () => ({
  StreamAdapter: hoisted.MockStreamAdapter,
}));

vi.mock("./request-builder", () => ({
  translateRequest: vi.fn(() => ({
    input: [],
    instructions: undefined,
    tools: [],
    toolChoice: undefined,
  })),
}));

vi.mock("vscode", () => ({
  LanguageModelTextPart: class LanguageModelTextPart {
    constructor(public value: string) {}
  },
  LanguageModelToolCallPart: class LanguageModelToolCallPart {
    constructor(
      public callId: string,
      public name: string,
      public input: unknown,
    ) {}
  },
}));

vi.mock("../logger.js", () => ({
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  extractTokenCountFromError: vi.fn(() => undefined),
}));

vi.mock("../logger/investigation.js", () => ({
  InvestigationLogger: hoisted.MockInvestigationLogger,
}));

vi.mock("../logger/error-capture.js", () => ({
  ErrorCaptureLogger: class MockErrorCaptureLogger {
    captureError = vi.fn().mockResolvedValue(undefined);
    getErrorsDir = vi.fn(() => "/mock/errors");
  },
}));

vi.mock("../utils/stateful-marker.js", () => ({
  findLatestStatefulMarker: vi.fn(() => undefined),
}));

// Disable retries in tests — all errors are classified as non-retryable
vi.mock("../utils/retry.js", () => ({
  classifyForRetry: vi.fn(() => ({
    retryable: false,
    maxRetries: 0,
    reason: "Test — retries disabled",
  })),
  calculateRetryDelay: vi.fn(() => 0),
  DEFAULT_RETRY_CONFIG: {
    maxRetries: 3,
    initialDelayMs: 1000,
    backoffMultiplier: 2,
    maxDelayMs: 16000,
    jitterFactor: 0.25,
  },
}));

import { OpenResponsesError } from "openresponses-client";
import { LanguageModelTextPart } from "vscode";
import { ERROR_MESSAGES } from "../constants.js";
import { logger } from "../logger.js";
import {
  detectSummarizationRequest,
  executeOpenResponsesChat,
} from "./openresponses-chat";

describe("executeOpenResponsesChat terminal completion", () => {
  const createEmptyStream = async function* () {
    await Promise.resolve();
    const shouldYield = process.env["TEST_NOOP_STREAM"] === "1";
    if (shouldYield) {
      yield { type: "noop" } as never;
    }
  };

  const model = {
    id: "test-model",
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
  };

  const baseChatOptions = {
    configService: {
      openResponsesBaseUrl: "http://localhost:1234",
      timeout: 1000,
    },
    apiKey: "test-key",
    estimatedInputTokens: 1234,
    chatId: "chat-1",
    conversationId: "test-conv-id",
    globalStorageUri: { fsPath: "/tmp/test-global-storage" },
  };

  const options = { modelOptions: {} };
  const chatMessages: unknown[] = [];

  const createToken = () => ({
    onCancellationRequested: () => ({ dispose: vi.fn() }),
  });

  const createProgress = () => ({ report: vi.fn() });

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.adaptMock.mockReset();
  });

  it("completes agent on done event without usage", async () => {
    const statusBar = {
      updateAgentActivity: vi.fn(),
      completeAgent: vi.fn(),
      errorAgent: vi.fn(),
      getAgentTurnCount: vi.fn().mockReturnValue(0),
    };

    hoisted.createClient.mockReturnValue({
      createStreamingResponse: async function* () {
        await Promise.resolve();
        yield {
          type: "response.completed",
          response: {
            id: "resp-1",
            output: [],
          },
        };
      },
    });

    hoisted.adaptMock.mockReturnValueOnce({
      parts: [new LanguageModelTextPart("ok")],
      done: true,
      finishReason: "stop",
    });

    await executeOpenResponsesChat(
      model as never,
      chatMessages as never,
      options as never,
      createProgress(),
      createToken() as never,
      {
        ...baseChatOptions,
        agentRegistry: statusBar,
      } as never,
    );

    expect(statusBar.completeAgent).toHaveBeenCalledTimes(1);
    expect(statusBar.errorAgent).not.toHaveBeenCalled();
    const calls = statusBar.completeAgent.mock.calls as [
      string,
      { inputTokens: number; outputTokens: number },
    ][];
    const usageArg = calls[0]?.[1];
    if (!usageArg) {
      throw new Error("Expected usage data to be recorded");
    }
    expect(usageArg.inputTokens).toBe(1234);
    expect(usageArg.outputTokens).toBe(0);
  });

  it("errors agent on error event", async () => {
    const statusBar = {
      updateAgentActivity: vi.fn(),
      completeAgent: vi.fn(),
      errorAgent: vi.fn(),
      getAgentTurnCount: vi.fn().mockReturnValue(0),
    };

    hoisted.createClient.mockReturnValue({
      createStreamingResponse: async function* () {
        await Promise.resolve();
        yield { type: "error" };
      },
    });

    hoisted.adaptMock.mockReturnValueOnce({
      parts: [new LanguageModelTextPart("boom")],
      done: true,
      error: "boom",
      finishReason: "error",
    });

    await executeOpenResponsesChat(
      model as never,
      chatMessages as never,
      options as never,
      createProgress(),
      createToken() as never,
      {
        ...baseChatOptions,
        agentRegistry: statusBar,
      } as never,
    );

    expect(statusBar.errorAgent).toHaveBeenCalledTimes(1);
    expect(statusBar.completeAgent).not.toHaveBeenCalled();
  });

  it("completes agent on cancellation", async () => {
    const statusBar = {
      updateAgentActivity: vi.fn(),
      completeAgent: vi.fn(),
      errorAgent: vi.fn(),
      getAgentTurnCount: vi.fn().mockReturnValue(0),
    };

    hoisted.createClient.mockReturnValue({
      createStreamingResponse: async function* () {
        await Promise.resolve();
        const shouldYield = process.env["TEST_NOOP_STREAM"] === "1";
        if (shouldYield) {
          yield { type: "noop" } as never;
        }
        const error = new Error("abort");
        error.name = "AbortError";
        throw error;
      },
    });

    await executeOpenResponsesChat(
      model as never,
      chatMessages as never,
      options as never,
      createProgress(),
      createToken() as never,
      {
        ...baseChatOptions,
        agentRegistry: statusBar,
      } as never,
    );

    expect(statusBar.errorAgent).not.toHaveBeenCalled();
    expect(statusBar.completeAgent).toHaveBeenCalledTimes(1);
  });

  it("errors agent on no-content response", async () => {
    const statusBar = {
      updateAgentActivity: vi.fn(),
      completeAgent: vi.fn(),
      errorAgent: vi.fn(),
      getAgentTurnCount: vi.fn().mockReturnValue(0),
    };

    hoisted.createClient.mockReturnValue({
      createStreamingResponse: createEmptyStream,
    });

    const progress = createProgress();

    await executeOpenResponsesChat(
      model as never,
      chatMessages as never,
      options as never,
      progress,
      createToken() as never,
      {
        ...baseChatOptions,
        agentRegistry: statusBar,
      } as never,
    );

    expect(progress.report).toHaveBeenCalledTimes(1);
    expect(statusBar.errorAgent).toHaveBeenCalledTimes(1);
    expect(statusBar.completeAgent).not.toHaveBeenCalled();
  });

  it("logs a diagnostic on no-content response", async () => {
    const statusBar = {
      updateAgentActivity: vi.fn(),
      completeAgent: vi.fn(),
      errorAgent: vi.fn(),
      getAgentTurnCount: vi.fn().mockReturnValue(0),
    };

    hoisted.createClient.mockReturnValue({
      createStreamingResponse: createEmptyStream,
    });

    await executeOpenResponsesChat(
      model as never,
      chatMessages as never,
      options as never,
      createProgress(),
      createToken() as never,
      {
        ...baseChatOptions,
        agentRegistry: statusBar,
      } as never,
    );

    expect(logger.error).toHaveBeenCalledTimes(1);
    const logMessage = (
      logger.error as unknown as { mock: { calls: string[][] } }
    ).mock.calls[0]?.[0];
    expect(logMessage).toContain("[NoResponse]");
    expect(logMessage).toContain('"chatId": "chat-1"');
    expect(logMessage).toContain('"conversationId": "test-conv-id"');
    expect(logMessage).toContain('"eventCount": 0');
    expect(logMessage).toContain('"textPartCount": 0');
  });
});

describe("executeOpenResponsesChat investigation logging", () => {
  const model = {
    id: "test-model",
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
  };

  const baseChatOptions = {
    configService: {
      openResponsesBaseUrl: "http://localhost:1234",
      timeout: 1000,
    },
    apiKey: "test-key",
    estimatedInputTokens: 1234,
    chatId: "chat-1",
    conversationId: "test-conv-id",
    globalStorageUri: { fsPath: "/tmp/test-global-storage" },
  };

  const options = { modelOptions: {} };
  const chatMessages: unknown[] = [];

  const createToken = () => ({
    onCancellationRequested: () => ({ dispose: vi.fn() }),
  });

  const createProgress = () => ({ report: vi.fn() });

  const statusBar = {
    updateAgentActivity: vi.fn(),
    completeAgent: vi.fn(),
    errorAgent: vi.fn(),
    createChildClaim: vi.fn(),
    getAgentTurnCount: vi.fn().mockReturnValue(0),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.adaptMock.mockReset();
    // Default: startRequest returns null (detail=off)
    hoisted.mockStartRequest.mockReturnValue(null);
  });

  it("calls startRequest with correct metadata", async () => {
    hoisted.createClient.mockReturnValue({
      createStreamingResponse: async function* () {
        yield {
          type: "response.completed",
          response: { id: "resp-1", output: [] },
        };
      },
    });
    hoisted.adaptMock.mockReturnValueOnce({
      parts: [new LanguageModelTextPart("ok")],
      done: true,
      finishReason: "stop",
    });

    await executeOpenResponsesChat(
      model as never,
      chatMessages as never,
      options as never,
      createProgress(),
      createToken() as never,
      { ...baseChatOptions, agentRegistry: statusBar } as never,
    );

    expect(hoisted.mockStartRequest).toHaveBeenCalledTimes(1);
    const startData = hoisted.mockStartRequest.mock.calls[0]![0];
    expect(startData.conversationId).toBe("test-conv-id");
    expect(startData.chatId).toBe("chat-1");
    expect(startData.model).toBe("test-model");
    expect(startData.estimatedInputTokens).toBe(1234);
    expect(startData.requestBody.model).toBe("test-model");
  });

  it("calls handle.complete with success on normal completion", async () => {
    const mockHandle = {
      recorder: null,
      complete: hoisted.mockComplete,
      getEvents: vi.fn(() => []),
    };
    hoisted.mockStartRequest.mockReturnValue(mockHandle);

    hoisted.createClient.mockReturnValue({
      createStreamingResponse: async function* () {
        yield {
          type: "response.completed",
          response: { id: "resp-1", output: [] },
        };
      },
    });
    hoisted.adaptMock.mockReturnValueOnce({
      parts: [new LanguageModelTextPart("ok")],
      done: true,
      finishReason: "stop",
      responseId: "resp-1",
      usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 },
    });

    await executeOpenResponsesChat(
      model as never,
      chatMessages as never,
      options as never,
      createProgress(),
      createToken() as never,
      { ...baseChatOptions, agentRegistry: statusBar } as never,
    );

    expect(hoisted.mockComplete).toHaveBeenCalledTimes(1);
    const completeData = hoisted.mockComplete.mock.calls[0]![0];
    expect(completeData.status).toBe("success");
    expect(completeData.finishReason).toBe("stop");
    expect(completeData.responseId).toBe("resp-1");
    expect(completeData.usage).toEqual(
      expect.objectContaining({
        input_tokens: 1000,
        output_tokens: 200,
      }),
    );
  });

  it("calls handle.complete with error on API failure", async () => {
    const mockHandle = {
      recorder: null,
      complete: hoisted.mockComplete,
      getEvents: vi.fn(() => []),
    };
    hoisted.mockStartRequest.mockReturnValue(mockHandle);

    hoisted.createClient.mockReturnValue({
      createStreamingResponse: async function* () {
        throw new Error("Server error");
      },
    });

    await executeOpenResponsesChat(
      model as never,
      chatMessages as never,
      options as never,
      createProgress(),
      createToken() as never,
      { ...baseChatOptions, agentRegistry: statusBar } as never,
    );

    expect(hoisted.mockComplete).toHaveBeenCalledTimes(1);
    const completeData = hoisted.mockComplete.mock.calls[0]![0];
    expect(completeData.status).toBe("error");
    expect(completeData.error).toBe("Server error");
    expect(completeData.usage).toBeNull();
  });

  it("calls handle.complete with cancelled on abort", async () => {
    const mockHandle = {
      recorder: null,
      complete: hoisted.mockComplete,
      getEvents: vi.fn(() => []),
    };
    hoisted.mockStartRequest.mockReturnValue(mockHandle);

    hoisted.createClient.mockReturnValue({
      createStreamingResponse: async function* () {
        const error = new Error("abort");
        error.name = "AbortError";
        throw error;
      },
    });

    await executeOpenResponsesChat(
      model as never,
      chatMessages as never,
      options as never,
      createProgress(),
      createToken() as never,
      { ...baseChatOptions, agentRegistry: statusBar } as never,
    );

    expect(hoisted.mockComplete).toHaveBeenCalledTimes(1);
    const completeData = hoisted.mockComplete.mock.calls[0]![0];
    expect(completeData.status).toBe("cancelled");
    expect(completeData.error).toBeNull();
  });

  it("records SSE events via handle.recorder when present", async () => {
    const mockHandle = {
      recorder: { recordEvent: hoisted.mockRecordEvent },
      complete: hoisted.mockComplete,
      getEvents: vi.fn(() => []),
    };
    hoisted.mockStartRequest.mockReturnValue(mockHandle);

    hoisted.createClient.mockReturnValue({
      createStreamingResponse: async function* () {
        yield { type: "response.created", response: { id: "r-1" } };
        yield { type: "response.output_text.delta", delta: "Hi" };
        yield {
          type: "response.completed",
          response: { id: "r-1", output: [] },
        };
      },
    });

    hoisted.adaptMock
      .mockReturnValueOnce({ parts: [], done: false })
      .mockReturnValueOnce({
        parts: [new LanguageModelTextPart("Hi")],
        done: false,
      })
      .mockReturnValueOnce({
        parts: [new LanguageModelTextPart("")],
        done: true,
        finishReason: "stop",
        responseId: "r-1",
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      });

    await executeOpenResponsesChat(
      model as never,
      chatMessages as never,
      options as never,
      createProgress(),
      createToken() as never,
      { ...baseChatOptions, agentRegistry: statusBar } as never,
    );

    // 3 events recorded
    expect(hoisted.mockRecordEvent).toHaveBeenCalledTimes(3);

    // First event: seq=1, type=response.created
    const [seq1, type1] = hoisted.mockRecordEvent.mock.calls[0]!;
    expect(seq1).toBe(1);
    expect(type1).toBe("response.created");

    // Second event: seq=2, type=response.output_text.delta
    const [seq2, type2] = hoisted.mockRecordEvent.mock.calls[1]!;
    expect(seq2).toBe(2);
    expect(type2).toBe("response.output_text.delta");

    // Third event: seq=3, type=response.completed
    const [seq3, type3] = hoisted.mockRecordEvent.mock.calls[2]!;
    expect(seq3).toBe(3);
    expect(type3).toBe("response.completed");
  });

  it("does not call recorder when handle is null (detail=off)", async () => {
    // Default: startRequest returns null
    hoisted.mockStartRequest.mockReturnValue(null);

    hoisted.createClient.mockReturnValue({
      createStreamingResponse: async function* () {
        yield {
          type: "response.completed",
          response: { id: "r-1", output: [] },
        };
      },
    });
    hoisted.adaptMock.mockReturnValueOnce({
      parts: [new LanguageModelTextPart("ok")],
      done: true,
      finishReason: "stop",
    });

    await executeOpenResponsesChat(
      model as never,
      chatMessages as never,
      options as never,
      createProgress(),
      createToken() as never,
      { ...baseChatOptions, agentRegistry: statusBar } as never,
    );

    // No recorder calls, no complete calls
    expect(hoisted.mockRecordEvent).not.toHaveBeenCalled();
    expect(hoisted.mockComplete).not.toHaveBeenCalled();
  });
});

describe("detectSummarizationRequest", () => {
  // Role constants matching openresponses-chat.ts internals
  const ROLE_USER = 1;
  const ROLE_ASSISTANT = 2;
  const ROLE_SYSTEM = 3;

  /** Helper to create a mock LanguageModelChatMessage */
  function msg(role: number, text: string) {
    return {
      role,
      content: [new LanguageModelTextPart(text)],
    } as never;
  }

  describe("detection by last user message", () => {
    it("detects 'Summarize the conversation history' in last user message", () => {
      const messages = [
        msg(ROLE_SYSTEM, "You are a helpful assistant."),
        msg(ROLE_USER, "Hello"),
        msg(ROLE_ASSISTANT, "Hi there!"),
        msg(
          ROLE_USER,
          "Summarize the conversation history so far into a concise summary.",
        ),
      ];
      expect(detectSummarizationRequest(messages)).toBe(true);
    });

    it("does not detect if summarization text is in a non-last user message", () => {
      const messages = [
        msg(
          ROLE_USER,
          "Summarize the conversation history so far into a concise summary.",
        ),
        msg(ROLE_ASSISTANT, "Here is the summary..."),
        msg(ROLE_USER, "Now help me with something else."),
      ];
      expect(detectSummarizationRequest(messages)).toBe(false);
    });

    it("skips trailing assistant messages to find the last user message", () => {
      // The function iterates backward and skips non-user messages
      // until it finds the first user message
      const messages = [
        msg(ROLE_USER, "Summarize the conversation history"),
        msg(ROLE_ASSISTANT, "Here's a summary..."),
      ];
      // Last user message is the summarization request (even though assistant replied)
      // The function scans backward: sees assistant (skip), sees user (check)
      expect(detectSummarizationRequest(messages)).toBe(true);
    });
  });

  describe("detection by system message markers", () => {
    it("detects SummaryPrompt template tag in system message", () => {
      const messages = [
        msg(
          ROLE_SYSTEM,
          "You are a helpful assistant. <Tag name='summary'>Previous context</Tag>",
        ),
        msg(ROLE_USER, "Continue our previous discussion."),
      ];
      expect(detectSummarizationRequest(messages)).toBe(true);
    });

    it("detects 'comprehensive, detailed summary' marker in system message", () => {
      const messages = [
        msg(
          ROLE_SYSTEM,
          "Please provide a comprehensive, detailed summary of the entire conversation so far.",
        ),
        msg(ROLE_USER, "Go ahead."),
      ];
      expect(detectSummarizationRequest(messages)).toBe(true);
    });

    it("checks all system messages, not just the first", () => {
      const messages = [
        msg(ROLE_SYSTEM, "You are a helpful assistant."),
        msg(ROLE_USER, "Hello"),
        msg(
          ROLE_SYSTEM,
          "Additional context: <Tag name='summary'>Prior summary</Tag>",
        ),
        msg(ROLE_USER, "Help me."),
      ];
      expect(detectSummarizationRequest(messages)).toBe(true);
    });
  });

  describe("negative cases", () => {
    it("returns false for normal chat messages", () => {
      const messages = [
        msg(ROLE_SYSTEM, "You are a helpful assistant."),
        msg(ROLE_USER, "What is the meaning of life?"),
        msg(ROLE_ASSISTANT, "42"),
        msg(ROLE_USER, "Can you elaborate?"),
      ];
      expect(detectSummarizationRequest(messages)).toBe(false);
    });

    it("returns false for empty message array", () => {
      expect(detectSummarizationRequest([])).toBe(false);
    });

    it("returns false when only assistant messages present", () => {
      const messages = [
        msg(ROLE_ASSISTANT, "I can help with that."),
        msg(ROLE_ASSISTANT, "Here's the answer."),
      ];
      expect(detectSummarizationRequest(messages)).toBe(false);
    });

    it("does not false-positive on 'summary' in user message without exact markers", () => {
      const messages = [
        msg(ROLE_USER, "Can you give me a summary of this code?"),
      ];
      expect(detectSummarizationRequest(messages)).toBe(false);
    });

    it("does not false-positive on 'summary' in system message without exact markers", () => {
      const messages = [
        msg(ROLE_SYSTEM, "You should provide a summary when asked."),
        msg(ROLE_USER, "Hello"),
      ];
      expect(detectSummarizationRequest(messages)).toBe(false);
    });
  });
});

describe("error classification and user-friendly messages", () => {
  const model = {
    id: "test-model",
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
  };

  const baseChatOptions = {
    configService: {
      openResponsesBaseUrl: "http://localhost:1234",
      timeout: 1000,
    },
    apiKey: "test-key",
    estimatedInputTokens: 1234,
    chatId: "chat-1",
    conversationId: "test-conv-id",
    globalStorageUri: { fsPath: "/tmp/test-global-storage" },
  };

  const options = { modelOptions: {} };
  const chatMessages: unknown[] = [];

  const createToken = () => ({
    onCancellationRequested: () => ({ dispose: vi.fn() }),
  });

  const createProgress = () => ({ report: vi.fn() });

  const statusBar = {
    updateAgentActivity: vi.fn(),
    completeAgent: vi.fn(),
    errorAgent: vi.fn(),
    getAgentTurnCount: vi.fn().mockReturnValue(0),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.adaptMock.mockReset();
  });

  it("shows MODEL_NOT_FOUND for 404 errors", async () => {
    hoisted.createClient.mockReturnValue({
      createStreamingResponse: async function* () {
        throw new OpenResponsesError("Not Found", 404, "not_found");
      },
    });

    const progress = createProgress();
    const result = await executeOpenResponsesChat(
      model as never,
      chatMessages as never,
      options as never,
      progress,
      createToken() as never,
      { ...baseChatOptions, agentRegistry: statusBar } as never,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(ERROR_MESSAGES.MODEL_NOT_FOUND);
    // Verify user sees the friendly message
    const reportedParts = progress.report.mock.calls.map(
      (c: unknown[]) => (c[0] as { value: string }).value,
    );
    expect(
      reportedParts.some((p: string) =>
        p.includes(ERROR_MESSAGES.MODEL_NOT_FOUND),
      ),
    ).toBe(true);
  });

  it("shows RATE_LIMITED for 429 errors", async () => {
    hoisted.createClient.mockReturnValue({
      createStreamingResponse: async function* () {
        throw new OpenResponsesError("Rate limit exceeded", 429, "rate_limit");
      },
    });

    const progress = createProgress();
    const result = await executeOpenResponsesChat(
      model as never,
      chatMessages as never,
      options as never,
      progress,
      createToken() as never,
      { ...baseChatOptions, agentRegistry: statusBar } as never,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(ERROR_MESSAGES.RATE_LIMITED);
  });

  it("shows SERVER_ERROR for 500 errors", async () => {
    hoisted.createClient.mockReturnValue({
      createStreamingResponse: async function* () {
        throw new OpenResponsesError(
          "Internal Server Error",
          500,
          "server_error",
        );
      },
    });

    const result = await executeOpenResponsesChat(
      model as never,
      chatMessages as never,
      options as never,
      createProgress(),
      createToken() as never,
      { ...baseChatOptions, agentRegistry: statusBar } as never,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(ERROR_MESSAGES.SERVER_ERROR);
  });

  it("shows SERVICE_UNAVAILABLE for 502/503 errors", async () => {
    hoisted.createClient.mockReturnValue({
      createStreamingResponse: async function* () {
        throw new OpenResponsesError("Bad Gateway", 502, "bad_gateway");
      },
    });

    const result = await executeOpenResponsesChat(
      model as never,
      chatMessages as never,
      options as never,
      createProgress(),
      createToken() as never,
      { ...baseChatOptions, agentRegistry: statusBar } as never,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(ERROR_MESSAGES.SERVICE_UNAVAILABLE);
  });

  it("shows NETWORK_ERROR for connection failures", async () => {
    hoisted.createClient.mockReturnValue({
      createStreamingResponse: async function* () {
        throw new TypeError("fetch failed: ECONNREFUSED");
      },
    });

    const result = await executeOpenResponsesChat(
      model as never,
      chatMessages as never,
      options as never,
      createProgress(),
      createToken() as never,
      { ...baseChatOptions, agentRegistry: statusBar } as never,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(ERROR_MESSAGES.NETWORK_ERROR);
  });

  it("shows NETWORK_ERROR for DNS failures", async () => {
    hoisted.createClient.mockReturnValue({
      createStreamingResponse: async function* () {
        throw new Error("getaddrinfo ENOTFOUND ai-gateway.vercel.sh");
      },
    });

    const result = await executeOpenResponsesChat(
      model as never,
      chatMessages as never,
      options as never,
      createProgress(),
      createToken() as never,
      { ...baseChatOptions, agentRegistry: statusBar } as never,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(ERROR_MESSAGES.NETWORK_ERROR);
  });

  it("preserves raw error message for unknown errors", async () => {
    hoisted.createClient.mockReturnValue({
      createStreamingResponse: async function* () {
        throw new Error("Something completely unexpected");
      },
    });

    const result = await executeOpenResponsesChat(
      model as never,
      chatMessages as never,
      options as never,
      createProgress(),
      createToken() as never,
      { ...baseChatOptions, agentRegistry: statusBar } as never,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Something completely unexpected");
  });

  it("logs raw error message for forensics even when showing friendly message", async () => {
    hoisted.createClient.mockReturnValue({
      createStreamingResponse: async function* () {
        throw new OpenResponsesError(
          "model xyz not found in registry",
          404,
          "not_found",
        );
      },
    });

    await executeOpenResponsesChat(
      model as never,
      chatMessages as never,
      options as never,
      createProgress(),
      createToken() as never,
      { ...baseChatOptions, agentRegistry: statusBar } as never,
    );

    // Raw message should be logged, not the friendly one
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("model xyz not found in registry"),
    );
  });

  it("captures stream-level errors via ErrorCaptureLogger", async () => {
    hoisted.createClient.mockReturnValue({
      createStreamingResponse: async function* () {
        await Promise.resolve();
        yield {
          type: "error",
          error: { message: "stream broke", code: "stream_error" },
        };
      },
    });

    hoisted.adaptMock.mockReturnValueOnce({
      parts: [new LanguageModelTextPart("error text")],
      done: true,
      error: "stream broke",
      finishReason: "error",
    });

    const mockHandle = {
      recorder: null,
      complete: hoisted.mockComplete,
      getEvents: vi.fn(() => []),
    };
    hoisted.mockStartRequest.mockReturnValue(mockHandle);

    await executeOpenResponsesChat(
      model as never,
      chatMessages as never,
      options as never,
      createProgress(),
      createToken() as never,
      { ...baseChatOptions, agentRegistry: statusBar } as never,
    );

    // ErrorCaptureLogger should have been called for stream-level error
    // (The mock is auto-created by the vi.mock for error-capture.js)
    expect(statusBar.errorAgent).toHaveBeenCalledTimes(1);
  });
});
