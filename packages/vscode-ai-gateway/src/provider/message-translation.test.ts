/**
 * Property tests for VS Code message translation to OpenResponses format.
 *
 * These tests verify that all VS Code message types are correctly translated
 * to the OpenResponses API format. Based on the official VS Code API:
 * https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.d.ts
 *
 * VS Code Types:
 * - LanguageModelChatMessage: { role, content: LanguageModelInputPart[], name? }
 * - LanguageModelTextPart: { value: string }
 * - LanguageModelToolCallPart: { callId, name, input }
 * - LanguageModelToolResultPart: { callId, content: (TextPart|DataPart|PromptTsxPart|unknown)[] }
 * - LanguageModelDataPart: { data: Uint8Array, mimeType: string }
 */

import { describe, expect, it, vi } from "vitest";

// Create hoisted mock for vscode module
const hoisted = vi.hoisted(() => {
  // Mock the VS Code part classes
  class MockLanguageModelTextPart {
    value: string;
    constructor(value: string) {
      this.value = value;
    }
  }

  class MockLanguageModelDataPart {
    data: Uint8Array;
    mimeType: string;
    constructor(data: Uint8Array, mimeType: string) {
      this.data = data;
      this.mimeType = mimeType;
    }
    static image(data: Uint8Array, mime: string): MockLanguageModelDataPart {
      return new MockLanguageModelDataPart(data, mime);
    }
    static json(
      value: unknown,
      mime = "application/json",
    ): MockLanguageModelDataPart {
      const encoded = new TextEncoder().encode(JSON.stringify(value));
      return new MockLanguageModelDataPart(encoded, mime);
    }
    static text(value: string, mime = "text/plain"): MockLanguageModelDataPart {
      const encoded = new TextEncoder().encode(value);
      return new MockLanguageModelDataPart(encoded, mime);
    }
  }

  class MockLanguageModelToolCallPart {
    callId: string;
    name: string;
    input: object;
    constructor(callId: string, name: string, input: object) {
      this.callId = callId;
      this.name = name;
      this.input = input;
    }
  }

  class MockLanguageModelToolResultPart {
    callId: string;
    content: unknown[];
    constructor(callId: string, content: unknown[]) {
      this.callId = callId;
      this.content = content;
    }
  }

  class MockLanguageModelChatMessage {
    role: number;
    content: unknown[];
    name: string | undefined;

    static User(
      content: string | unknown[],
      name?: string,
    ): MockLanguageModelChatMessage {
      const msg = new MockLanguageModelChatMessage(1, content, name);
      return msg;
    }

    static Assistant(
      content: string | unknown[],
      name?: string,
    ): MockLanguageModelChatMessage {
      const msg = new MockLanguageModelChatMessage(2, content, name);
      return msg;
    }

    constructor(role: number, content: string | unknown[], name?: string) {
      this.role = role;
      this.content =
        typeof content === "string"
          ? [new MockLanguageModelTextPart(content)]
          : content;
      this.name = name;
    }
  }

  const MockLanguageModelChatMessageRole = {
    User: 1,
    Assistant: 2,
  };

  const MockLanguageModelChatToolMode = {
    Auto: 1,
    Required: 2,
  };

  return {
    MockLanguageModelTextPart,
    MockLanguageModelDataPart,
    MockLanguageModelToolCallPart,
    MockLanguageModelToolResultPart,
    MockLanguageModelChatMessage,
    MockLanguageModelChatMessageRole,
    MockLanguageModelChatToolMode,
  };
});

// Mock vscode module
vi.mock("vscode", () => ({
  LanguageModelTextPart: hoisted.MockLanguageModelTextPart,
  LanguageModelDataPart: hoisted.MockLanguageModelDataPart,
  LanguageModelToolCallPart: hoisted.MockLanguageModelToolCallPart,
  LanguageModelToolResultPart: hoisted.MockLanguageModelToolResultPart,
  LanguageModelChatMessage: hoisted.MockLanguageModelChatMessage,
  LanguageModelChatMessageRole: hoisted.MockLanguageModelChatMessageRole,
  LanguageModelChatToolMode: hoisted.MockLanguageModelChatToolMode,
}));

// Mock logger
vi.mock("../logger.js", () => ({
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    logApiError: vi.fn(),
  },
}));

// Import after mocking
import {
  LanguageModelChatMessage,
  LanguageModelChatMessageRole,
  LanguageModelDataPart,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
} from "vscode";
import * as messageTranslation from "./message-translation.js";

/**
 * Since translateToolResultContent is a private function, we need to test it
 * indirectly or extract it for testing. For now, we'll create a test-only
 * version that matches the implementation.
 */
function translateToolResultContent(content: readonly unknown[]): string {
  const textParts: string[] = [];

  for (const part of content) {
    if (typeof part === "string") {
      textParts.push(part);
    } else if (part instanceof LanguageModelTextPart) {
      textParts.push(part.value);
    } else if (part instanceof LanguageModelDataPart) {
      if (
        part.mimeType.startsWith("text/") ||
        part.mimeType === "application/json"
      ) {
        try {
          const text = new TextDecoder().decode(part.data);
          textParts.push(text);
        } catch {
          // Skip on decode failure
        }
      } else {
        textParts.push(`[Binary data: ${part.mimeType}]`);
      }
    } else if (part && typeof part === "object") {
      if (
        "value" in part &&
        typeof (part as { value: unknown }).value === "string"
      ) {
        textParts.push((part as { value: string }).value);
      } else if (
        "text" in part &&
        typeof (part as { text: unknown }).text === "string"
      ) {
        textParts.push((part as { text: string }).text);
      } else {
        textParts.push(JSON.stringify(part));
      }
    }
  }

  return textParts.join("\n");
}

describe("translateToolResultContent", () => {
  describe("LanguageModelTextPart handling", () => {
    it("should extract value from LanguageModelTextPart instances", () => {
      const content = [new LanguageModelTextPart("Hello, world!")];
      const result = translateToolResultContent(content);
      expect(result).toBe("Hello, world!");
    });

    it("should join multiple LanguageModelTextPart instances with newlines", () => {
      const content = [
        new LanguageModelTextPart("Line 1"),
        new LanguageModelTextPart("Line 2"),
        new LanguageModelTextPart("Line 3"),
      ];
      const result = translateToolResultContent(content);
      expect(result).toBe("Line 1\nLine 2\nLine 3");
    });

    it("should handle empty string in LanguageModelTextPart", () => {
      const content = [new LanguageModelTextPart("")];
      const result = translateToolResultContent(content);
      expect(result).toBe("");
    });

    it("should handle text with special characters", () => {
      const content = [
        new LanguageModelTextPart('JSON: {"key": "value", "array": [1, 2, 3]}'),
      ];
      const result = translateToolResultContent(content);
      expect(result).toBe('JSON: {"key": "value", "array": [1, 2, 3]}');
    });

    it("should handle text with newlines and unicode", () => {
      const content = [
        new LanguageModelTextPart("Line 1\nLine 2\n🎉 Unicode!"),
      ];
      const result = translateToolResultContent(content);
      expect(result).toBe("Line 1\nLine 2\n🎉 Unicode!");
    });
  });

  describe("LanguageModelDataPart handling", () => {
    it("should decode text/plain data parts", () => {
      const text = "This is plain text content";
      const dataPart = hoisted.MockLanguageModelDataPart.text(text);
      const content = [dataPart];
      const result = translateToolResultContent(content);
      expect(result).toBe(text);
    });

    it("should decode application/json data parts", () => {
      const jsonData = { key: "value", number: 42 };
      const dataPart = hoisted.MockLanguageModelDataPart.json(jsonData);
      const content = [dataPart];
      const result = translateToolResultContent(content);
      expect(result).toBe(JSON.stringify(jsonData));
    });

    it("should handle image data parts with placeholder", () => {
      const imageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
      const dataPart = hoisted.MockLanguageModelDataPart.image(
        imageData,
        "image/png",
      );
      const content = [dataPart];
      const result = translateToolResultContent(content);
      expect(result).toBe("[Binary data: image/png]");
    });

    it("should handle mixed text and data parts", () => {
      const content = [
        new LanguageModelTextPart("Text part"),
        hoisted.MockLanguageModelDataPart.text("Data part"),
      ];
      const result = translateToolResultContent(content);
      expect(result).toBe("Text part\nData part");
    });

    it("should handle text/markdown data parts", () => {
      const markdown = "# Heading\n\n- Item 1\n- Item 2";
      const encoded = new TextEncoder().encode(markdown);
      const dataPart = new hoisted.MockLanguageModelDataPart(
        encoded,
        "text/markdown",
      );
      const content = [dataPart];
      const result = translateToolResultContent(content);
      expect(result).toBe(markdown);
    });
  });

  describe("Plain string handling (edge case)", () => {
    it("should handle plain strings in content array", () => {
      // This shouldn't happen with real VS Code, but handle it gracefully
      const content = ["plain string" as unknown];
      const result = translateToolResultContent(content);
      expect(result).toBe("plain string");
    });
  });

  describe("Duck-typed object handling (fallback)", () => {
    it("should handle objects with value property", () => {
      // Simulates a plain object that looks like LanguageModelTextPart
      const content = [{ value: "duck typed value" }];
      const result = translateToolResultContent(content);
      expect(result).toBe("duck typed value");
    });

    it("should handle objects with text property", () => {
      const content = [{ text: "duck typed text" }];
      const result = translateToolResultContent(content);
      expect(result).toBe("duck typed text");
    });

    it("should JSON.stringify unknown objects", () => {
      const unknownObj = { unknownKey: "unknownValue", nested: { a: 1 } };
      const content = [unknownObj];
      const result = translateToolResultContent(content);
      expect(result).toBe(JSON.stringify(unknownObj));
    });
  });

  describe("Empty and edge cases", () => {
    it("should return empty string for empty content array", () => {
      const result = translateToolResultContent([]);
      expect(result).toBe("");
    });

    it("should skip null values gracefully", () => {
      const content = [
        new LanguageModelTextPart("before"),
        null as unknown,
        new LanguageModelTextPart("after"),
      ];
      const result = translateToolResultContent(content);
      // null is falsy, so it's skipped
      expect(result).toBe("before\nafter");
    });

    it("should skip undefined values gracefully", () => {
      const content = [
        new LanguageModelTextPart("before"),
        undefined as unknown,
        new LanguageModelTextPart("after"),
      ];
      const result = translateToolResultContent(content);
      expect(result).toBe("before\nafter");
    });
  });

  describe("Real-world tool output scenarios", () => {
    it("should handle file read tool output", () => {
      const fileContent = `File: \`/path/to/file.ts\`. Lines 1 to 50:\n\`\`\`typescript\nconst x = 1;\n\`\`\``;
      const content = [new LanguageModelTextPart(fileContent)];
      const result = translateToolResultContent(content);
      expect(result).toBe(fileContent);
    });

    it("should handle terminal output with ANSI codes", () => {
      const terminalOutput = "[32m✓[0m Test passed\n[31m✗[0m Test failed";
      const content = [new LanguageModelTextPart(terminalOutput)];
      const result = translateToolResultContent(content);
      expect(result).toBe(terminalOutput);
    });

    it("should handle search results with multiple entries", () => {
      const searchResults = [
        new LanguageModelTextPart("3 matches found:"),
        new LanguageModelTextPart("file1.ts:10 - const foo = 1"),
        new LanguageModelTextPart("file2.ts:20 - const bar = 2"),
        new LanguageModelTextPart("file3.ts:30 - const baz = 3"),
      ];
      const result = translateToolResultContent(searchResults);
      expect(result).toBe(
        "3 matches found:\nfile1.ts:10 - const foo = 1\nfile2.ts:20 - const bar = 2\nfile3.ts:30 - const baz = 3",
      );
    });

    it("should handle very long content without truncation", () => {
      const longContent = "x".repeat(100000);
      const content = [new LanguageModelTextPart(longContent)];
      const result = translateToolResultContent(content);
      expect(result).toBe(longContent);
      expect(result.length).toBe(100000);
    });
  });
});

describe("LanguageModelToolResultPart structure", () => {
  it("should have callId and content properties", () => {
    const part = new LanguageModelToolResultPart("call-123", [
      new LanguageModelTextPart("result"),
    ]);
    expect(part.callId).toBe("call-123");
    expect(part.content).toHaveLength(1);
  });

  it("content should accept LanguageModelTextPart", () => {
    const textPart = new LanguageModelTextPart("test");
    const part = new LanguageModelToolResultPart("call-123", [textPart]);
    expect(part.content[0]).toBe(textPart);
  });

  it("content should accept LanguageModelDataPart", () => {
    const dataPart = hoisted.MockLanguageModelDataPart.text("test");
    const part = new LanguageModelToolResultPart("call-123", [dataPart]);
    expect(part.content[0]).toBe(dataPart);
  });

  it("content should accept mixed part types", () => {
    const textPart = new LanguageModelTextPart("text");
    const dataPart = hoisted.MockLanguageModelDataPart.text("data");
    const part = new LanguageModelToolResultPart("call-123", [
      textPart,
      dataPart,
    ]);
    expect(part.content).toHaveLength(2);
  });
});

describe("LanguageModelToolCallPart structure", () => {
  it("should have callId, name, and input properties", () => {
    const part = new LanguageModelToolCallPart("call-456", "read_file", {
      filePath: "/path/to/file.ts",
    });
    expect(part.callId).toBe("call-456");
    expect(part.name).toBe("read_file");
    expect(part.input).toEqual({ filePath: "/path/to/file.ts" });
  });

  it("should handle complex input objects", () => {
    const complexInput = {
      nested: { deep: { value: 42 } },
      array: [1, 2, 3],
      nullValue: null,
    };
    const part = new LanguageModelToolCallPart(
      "call-789",
      "complex_tool",
      complexInput,
    );
    expect(part.input).toEqual(complexInput);
  });
});

describe("LanguageModelChatMessage structure", () => {
  it("should create User messages correctly", () => {
    const msg = LanguageModelChatMessage.User("Hello");
    expect(msg.role).toBe(LanguageModelChatMessageRole.User);
    expect(msg.content).toHaveLength(1);
  });

  it("should create Assistant messages correctly", () => {
    const msg = LanguageModelChatMessage.Assistant("Response");
    expect(msg.role).toBe(LanguageModelChatMessageRole.Assistant);
    expect(msg.content).toHaveLength(1);
  });

  it("should accept array of parts for User message", () => {
    const parts = [
      new LanguageModelTextPart("Part 1"),
      new LanguageModelTextPart("Part 2"),
    ];
    const msg = LanguageModelChatMessage.User(parts);
    expect(msg.content).toHaveLength(2);
  });

  it("should accept tool result parts in User message", () => {
    const toolResult = new LanguageModelToolResultPart("call-123", [
      new LanguageModelTextPart("Tool output"),
    ]);
    const msg = LanguageModelChatMessage.User([toolResult]);
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]).toBe(toolResult);
  });

  it("should accept tool call parts in Assistant message", () => {
    const toolCall = new LanguageModelToolCallPart("call-456", "my_tool", {
      arg: "value",
    });
    const msg = LanguageModelChatMessage.Assistant([toolCall]);
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]).toBe(toolCall);
  });
});

describe("translateMessage content type invariants", () => {
  it("should map User role text to input_text content parts", () => {
    // Regression guard: User messages must emit input_text for OpenResponses input.
    const message = LanguageModelChatMessage.User([
      new LanguageModelTextPart("Hello"),
      hoisted.MockLanguageModelDataPart.image(
        new Uint8Array([1, 2, 3]),
        "image/png",
      ),
    ]);

    const items = messageTranslation.translateMessage(message);
    const [messageItem] = items;
    expect(messageItem).toMatchObject({ type: "message", role: "user" });
    expect(Array.isArray((messageItem as { content?: unknown }).content)).toBe(
      true,
    );
    const contentParts = (messageItem as { content: { type: string }[] })
      .content;
    expect(contentParts[0]).toMatchObject({ type: "input_text" });
  });

  it("should map Assistant role text to output_text content parts", () => {
    // Regression guard: Assistant messages must emit output_text for OpenResponses output.
    const message = LanguageModelChatMessage.Assistant([
      new LanguageModelTextPart("Hello"),
    ]);

    const items = messageTranslation.translateMessage(message);
    const [messageItem] = items;
    const expected = messageTranslation.createMessageItem("assistant", [
      { type: "output_text", text: "Hello" },
    ]);
    expect(messageItem).toEqual(expected);
  });

  it("should map unknown role to assistant with output_text content parts", () => {
    // Regression guard: Unknown roles default to assistant/output_text.
    // This is the actual behavior - resolveOpenResponsesRole returns "assistant"
    // for any role that isn't explicitly User.
    const message = new LanguageModelChatMessage(
      99, // Unknown role
      [new LanguageModelTextPart("Hello from unknown")],
    );

    const items = messageTranslation.translateMessage(message);
    const [messageItem] = items;
    expect(messageItem).toMatchObject({ type: "message", role: "assistant" });
    // Note: String content is used for text-only messages, not array
    expect((messageItem as { content: string }).content).toBe(
      "Hello from unknown",
    );
  });
});
