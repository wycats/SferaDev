import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "vscode";
import { LAST_SELECTED_MODEL_KEY } from "./constants";
import { VercelAIChatModelProvider } from "./provider";

// Create hoisted mock functions
const hoisted = vi.hoisted(() => {
  const mockEventEmitterFire = vi.fn();
  const mockEventEmitterDispose = vi.fn();
  const mockEventEmitterEvent = vi.fn();
  const mockDisposable = { dispose: vi.fn() };

  class MockEventEmitter {
    event = mockEventEmitterEvent;
    fire = mockEventEmitterFire;
    dispose = mockEventEmitterDispose;
  }

  const mockGetSession = vi.fn();
  const mockShowErrorMessage = vi.fn();
  const mockGetConfiguration = vi.fn();

  // Mock LanguageModel* part constructors
  class MockLanguageModelTextPart {
    constructor(public value: string) {}
  }

  class MockLanguageModelToolCallPart {
    constructor(
      public callId: string,
      public name: string,
      public input: unknown,
    ) {}
  }

  class MockLanguageModelToolResultPart {
    constructor(
      public callId: string,
      public content: unknown[],
    ) {}
  }

  class MockLanguageModelDataPart {
    constructor(
      public data: Uint8Array,
      public mimeType: string,
    ) {}

    static image(data: Uint8Array, mimeType: string) {
      return new MockLanguageModelDataPart(data, mimeType);
    }

    static text(value: string, mimeType: string) {
      return new MockLanguageModelDataPart(
        new TextEncoder().encode(value),
        mimeType,
      );
    }

    static json(value: unknown, mimeType = "application/json") {
      return new MockLanguageModelDataPart(
        new TextEncoder().encode(JSON.stringify(value)),
        mimeType,
      );
    }
  }

  // Optional: Mock LanguageModelThinkingPart (unstable API)
  class MockLanguageModelThinkingPart {
    constructor(
      public text: string,
      public id?: string,
    ) {}
  }

  return {
    mockEventEmitterFire,
    mockEventEmitterDispose,
    mockEventEmitterEvent,
    MockEventEmitter,
    mockDisposable,
    mockGetSession,
    mockShowErrorMessage,
    mockGetConfiguration,
    MockLanguageModelTextPart,
    MockLanguageModelToolCallPart,
    MockLanguageModelToolResultPart,
    MockLanguageModelDataPart,
    MockLanguageModelThinkingPart,
  };
});

// Mock vscode module
vi.mock("vscode", () => ({
  EventEmitter: hoisted.MockEventEmitter,
  authentication: {
    getSession: hoisted.mockGetSession,
  },
  window: {
    showErrorMessage: hoisted.mockShowErrorMessage,
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    })),
  },
  workspace: {
    getConfiguration: hoisted.mockGetConfiguration,
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
  },
  LanguageModelTextPart: hoisted.MockLanguageModelTextPart,
  LanguageModelToolCallPart: hoisted.MockLanguageModelToolCallPart,
  LanguageModelToolResultPart: hoisted.MockLanguageModelToolResultPart,
  LanguageModelDataPart: hoisted.MockLanguageModelDataPart,
  LanguageModelThinkingPart: hoisted.MockLanguageModelThinkingPart,
  LanguageModelChatMessageRole: {
    User: 1,
    Assistant: 2,
  },
  LanguageModelChatToolMode: {
    Auto: "auto",
    Required: "required",
  },
}));

// Mock the auth module
vi.mock("./auth", () => ({
  VERCEL_AI_AUTH_PROVIDER_ID: "vercelAiAuth",
}));

vi.mock("./models", () => ({
  ModelsClient: class {
    getModels = vi.fn();
    initializePersistence = vi.fn();
  },
}));

function createProvider() {
  const context = {
    workspaceState: {
      get: vi.fn(),
      update: vi.fn(),
    },
    globalState: {
      get: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as ExtensionContext;

  return new VercelAIChatModelProvider(context);
}

describe("Provider instantiation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.mockGetConfiguration.mockReturnValue({
      get: (_key: string, defaultValue?: unknown) => defaultValue,
    });
  });

  it("creates a provider instance", () => {
    const provider = createProvider();
    expect(provider).toBeInstanceOf(VercelAIChatModelProvider);
  });

  it("disposes cleanly", () => {
    const provider = createProvider();
    expect(() => { provider.dispose(); }).not.toThrow();
  });
});

describe("Model selection memory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.mockGetConfiguration.mockReturnValue({
      get: (_key: string, defaultValue?: unknown) => defaultValue,
    });
  });

  it("returns the last selected model id from workspace state", () => {
    const getMock = vi.fn().mockReturnValue("stored-model");
    const context = {
      workspaceState: {
        get: getMock,
        update: vi.fn(),
      },
      globalState: {
        get: vi.fn(),
        update: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as ExtensionContext;

    const provider = new VercelAIChatModelProvider(context);

    expect(provider.getLastSelectedModelId()).toBe("stored-model");
    expect(getMock).toHaveBeenCalledWith(
      LAST_SELECTED_MODEL_KEY,
    );
  });

  it("returns undefined when no model has been selected", () => {
    const context = {
      workspaceState: {
        get: vi.fn().mockReturnValue(undefined),
        update: vi.fn(),
      },
      globalState: {
        get: vi.fn(),
        update: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as ExtensionContext;

    const provider = new VercelAIChatModelProvider(context);

    expect(provider.getLastSelectedModelId()).toBeUndefined();
  });
});
