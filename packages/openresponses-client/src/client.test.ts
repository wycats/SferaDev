import { describe, expect, it } from "vitest";

import { parseSSEChunk, type StreamingEvent } from "./client.js";

const makeEvent = (delta: string) =>
  ({
    type: "response.output_text.delta",
    delta,
  } as unknown as StreamingEvent);

describe("parseSSEChunk", () => {
  it("parses LF data lines", () => {
    const event = makeEvent("hello");
    const chunk = `data: ${JSON.stringify(event)}\n`;

    expect(parseSSEChunk(chunk)).toEqual([event]);
  });

  it("parses CRLF data lines", () => {
    const event = makeEvent("hello");
    const chunk = `data: ${JSON.stringify(event)}\r\n`;

    expect(parseSSEChunk(chunk)).toEqual([event]);
  });

  it("parses mixed CRLF/LF line endings with multiple events", () => {
    const first = makeEvent("one");
    const second = makeEvent("two");
    const chunk = `data: ${JSON.stringify(first)}\r\n\r\n` +
      `data: ${JSON.stringify(second)}\n`;

    expect(parseSSEChunk(chunk)).toEqual([first, second]);
  });

  it("joins multiline data before parsing", () => {
    const expected = makeEvent("hello");
    const chunk =
      "data: {\"type\":\"response.output_text.delta\"," +
      "\n" +
      "data: \"delta\":\"hello\"}\n";

    expect(parseSSEChunk(chunk)).toEqual([expected]);
  });

  it("ignores empty data lines and [DONE]", () => {
    const chunk = "data: \n\n" + "data: [DONE]\n";

    expect(parseSSEChunk(chunk)).toEqual([]);
  });
});
