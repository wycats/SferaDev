import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const createClient = vi.fn();
  const adaptMock = vi.fn();
  const appendCapsuleToContent = vi.fn();
  const extractCapsuleFromMessages = vi.fn();
  const generateConversationId = vi.fn();
  const generateAgentId = vi.fn();

  class MockStreamAdapter {
    adapt = adaptMock;
    reset = vi.fn();
  }

  return {
    createClient,
    adaptMock,
    appendCapsuleToContent,
    extractCapsuleFromMessages,
    generateConversationId,
    generateAgentId,
    MockStreamAdapter,
  };
});

vi.mock("openresponses-client", () => ({
  createClient: hoisted.createClient,
  OpenResponsesError: class OpenResponsesError extends Error {
    code?: string;
    status?: number;
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

vi.mock("../identity/capsule.js", () => ({
  appendCapsuleToContent: hoisted.appendCapsuleToContent,
  extractCapsuleFromMessages: hoisted.extractCapsuleFromMessages,
  generateConversationId: hoisted.generateConversationId,
  generateAgentId: hoisted.generateAgentId,
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

import { LanguageModelTextPart } from "vscode";
import { executeOpenResponsesChat } from "./openresponses-chat";

describe("executeOpenResponsesChat terminal completion", () => {
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
    hoisted.extractCapsuleFromMessages.mockReturnValue(null);
    hoisted.generateConversationId.mockReturnValue("conv_default");
    hoisted.generateAgentId.mockReturnValue("agent_default");
    hoisted.appendCapsuleToContent.mockImplementation((content, capsule) => {
      const pid = capsule.pid ? ` pid:${capsule.pid}` : "";
      return `${content}\n<!-- v.cid:${capsule.cid} aid:${capsule.aid}${pid} -->`;
    });
  });

  it("completes agent on done event without usage", async () => {
    const statusBar = {
      updateAgentActivity: vi.fn(),
      completeAgent: vi.fn(),
      errorAgent: vi.fn(),
    };

    hoisted.createClient.mockReturnValue({
      createStreamingResponse: async function* () {
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
        statusBar,
      } as never,
    );

    expect(statusBar.completeAgent).toHaveBeenCalledTimes(1);
    expect(statusBar.errorAgent).not.toHaveBeenCalled();
    const usageArg = statusBar.completeAgent.mock.calls[0]![1];
    expect(usageArg.inputTokens).toBe(1234);
    expect(usageArg.outputTokens).toBe(0);
  });

  it("errors agent on error event", async () => {
    const statusBar = {
      updateAgentActivity: vi.fn(),
      completeAgent: vi.fn(),
      errorAgent: vi.fn(),
    };

    hoisted.createClient.mockReturnValue({
      createStreamingResponse: async function* () {
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
        statusBar,
      } as never,
    );

    expect(statusBar.errorAgent).toHaveBeenCalledTimes(1);
    expect(statusBar.completeAgent).not.toHaveBeenCalled();
  });

  it("errors agent on cancellation", async () => {
    const statusBar = {
      updateAgentActivity: vi.fn(),
      completeAgent: vi.fn(),
      errorAgent: vi.fn(),
    };

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
      {
        ...baseChatOptions,
        statusBar,
      } as never,
    );

    expect(statusBar.errorAgent).toHaveBeenCalledTimes(1);
    expect(statusBar.completeAgent).not.toHaveBeenCalled();
  });

  it("errors agent on no-content response", async () => {
    const statusBar = {
      updateAgentActivity: vi.fn(),
      completeAgent: vi.fn(),
      errorAgent: vi.fn(),
    };

    hoisted.createClient.mockReturnValue({
      createStreamingResponse: async function* () {},
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
        statusBar,
      } as never,
    );

    expect(progress.report).toHaveBeenCalledTimes(1);
    expect(statusBar.errorAgent).toHaveBeenCalledTimes(1);
    expect(statusBar.completeAgent).not.toHaveBeenCalled();
  });

  it("injects capsule on completion with usage", async () => {
    const statusBar = {
      updateAgentActivity: vi.fn(),
      completeAgent: vi.fn(),
      errorAgent: vi.fn(),
    };

    hoisted.generateConversationId.mockReturnValue("conv_1");
    hoisted.generateAgentId.mockReturnValue("agent_1");

    hoisted.createClient.mockReturnValue({
      createStreamingResponse: async function* () {
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
      parts: [new LanguageModelTextPart("hello")],
      done: true,
      finishReason: "stop",
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    await executeOpenResponsesChat(
      model as never,
      chatMessages as never,
      options as never,
      createProgress(),
      createToken() as never,
      {
        ...baseChatOptions,
        statusBar,
      } as never,
    );

    expect(hoisted.appendCapsuleToContent).toHaveBeenCalledWith("hello", {
      cid: "conv_1",
      aid: "agent_1",
    });
    const responseText = statusBar.completeAgent.mock.calls[0]![2];
    expect(responseText).toBe("hello\n<!-- v.cid:conv_1 aid:agent_1 -->");
  });

  it("reuses existing conversation ID and parent ID", async () => {
    const statusBar = {
      updateAgentActivity: vi.fn(),
      completeAgent: vi.fn(),
      errorAgent: vi.fn(),
    };

    hoisted.extractCapsuleFromMessages.mockReturnValue({
      cid: "conv_existing",
      aid: "agent_old",
      pid: "parent_1",
    });
    hoisted.generateAgentId.mockReturnValue("agent_new");

    hoisted.createClient.mockReturnValue({
      createStreamingResponse: async function* () {
        yield {
          type: "response.completed",
          response: {
            id: "resp-2",
            output: [],
          },
        };
      },
    });

    hoisted.adaptMock.mockReturnValueOnce({
      parts: [new LanguageModelTextPart("continue")],
      done: true,
      finishReason: "stop",
      usage: { input_tokens: 5, output_tokens: 6 },
    });

    await executeOpenResponsesChat(
      model as never,
      chatMessages as never,
      options as never,
      createProgress(),
      createToken() as never,
      {
        ...baseChatOptions,
        statusBar,
      } as never,
    );

    expect(hoisted.generateConversationId).not.toHaveBeenCalled();
    expect(hoisted.appendCapsuleToContent).toHaveBeenCalledWith("continue", {
      cid: "conv_existing",
      aid: "agent_new",
      pid: "parent_1",
    });
  });

  it("does not inject capsule on error", async () => {
    const statusBar = {
      updateAgentActivity: vi.fn(),
      completeAgent: vi.fn(),
      errorAgent: vi.fn(),
    };

    hoisted.createClient.mockReturnValue({
      createStreamingResponse: async function* () {
        yield {
          type: "error",
        };
      },
    });

    hoisted.adaptMock.mockReturnValueOnce({
      parts: [new LanguageModelTextPart("boom")],
      done: true,
      error: "boom",
      finishReason: "error",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await executeOpenResponsesChat(
      model as never,
      chatMessages as never,
      options as never,
      createProgress(),
      createToken() as never,
      {
        ...baseChatOptions,
        statusBar,
      } as never,
    );

    expect(hoisted.appendCapsuleToContent).not.toHaveBeenCalled();
    expect(statusBar.errorAgent).toHaveBeenCalledTimes(1);
  });
});
