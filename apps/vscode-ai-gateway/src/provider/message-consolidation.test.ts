import { describe, expect, it } from "vitest";
import type { ItemParam } from "openresponses-client";
import { consolidateConsecutiveMessages } from "./message-consolidation.js";

function userMessage(content: string | { type: "input_text"; text: string }[]): ItemParam {
  return {
    type: "message",
    role: "user",
    content,
  } as ItemParam;
}

function assistantMessage(
  content: string | { type: "output_text"; text: string }[],
): ItemParam {
  return {
    type: "message",
    role: "assistant",
    content,
  } as ItemParam;
}

function functionCall(callId = "call_1"): ItemParam {
  return {
    type: "function_call",
    call_id: callId,
    name: "read_file",
    arguments: "{}",
  } as ItemParam;
}

function functionCallOutput(callId = "call_1"): ItemParam {
  return {
    type: "function_call_output",
    call_id: callId,
    output: "ok",
  } as ItemParam;
}

describe("consolidateConsecutiveMessages", () => {
  it("returns empty array for empty input", () => {
    expect(consolidateConsecutiveMessages([])).toEqual([]);
  });

  it("passes through a single message", () => {
    const input = [userMessage("Hello")];
    expect(consolidateConsecutiveMessages(input)).toEqual([
      {
        type: "message",
        role: "user",
        content: "Hello",
      },
    ]);
  });

  it("keeps alternating roles unchanged", () => {
    const input = [userMessage("Hi"), assistantMessage("Hello"), userMessage("Next")];
    expect(consolidateConsecutiveMessages(input)).toEqual([
      { type: "message", role: "user", content: "Hi" },
      { type: "message", role: "assistant", content: "Hello" },
      { type: "message", role: "user", content: "Next" },
    ]);
  });

  it("merges consecutive user messages with separator", () => {
    const input = [userMessage("First"), userMessage("Second")];
    expect(consolidateConsecutiveMessages(input)).toEqual([
      {
        type: "message",
        role: "user",
        content: "First\n\n---\n\nSecond",
      },
    ]);
  });

  it("merges consecutive assistant messages", () => {
    const input = [assistantMessage("One"), assistantMessage("Two")];
    expect(consolidateConsecutiveMessages(input)).toEqual([
      {
        type: "message",
        role: "assistant",
        content: "One\n\n---\n\nTwo",
      },
    ]);
  });

  it("does not merge across non-message items", () => {
    const input = [
      userMessage("Before"),
      functionCall("call_a"),
      userMessage("After"),
      functionCallOutput("call_a"),
      userMessage("Final"),
    ];

    expect(consolidateConsecutiveMessages(input)).toEqual([
      { type: "message", role: "user", content: "Before" },
      functionCall("call_a"),
      { type: "message", role: "user", content: "After" },
      functionCallOutput("call_a"),
      { type: "message", role: "user", content: "Final" },
    ]);
  });

  it("merges mixed content arrays with input_text/output_text", () => {
    const input = [
      userMessage([
        { type: "input_text", text: "First" },
        { type: "input_text", text: "Second" },
      ]),
      userMessage([{ type: "input_text", text: "Third" }]),
      assistantMessage([{ type: "output_text", text: "Assistant One" }]),
      assistantMessage([{ type: "output_text", text: "Assistant Two" }]),
    ];

    expect(consolidateConsecutiveMessages(input)).toEqual([
      {
        type: "message",
        role: "user",
        content: "First\nSecond\n\n---\n\nThird",
      },
      {
        type: "message",
        role: "assistant",
        content: "Assistant One\n\n---\n\nAssistant Two",
      },
    ]);
  });
});
