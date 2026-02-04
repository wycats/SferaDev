import { describe, expect, it, vi } from "vitest";

import { createClient, parseSSEChunk, type StreamingEvent } from "./client.js";

const makeEvent = (delta: string) =>
  ({
    type: "response.output_text.delta",
    delta,
  }) as unknown as StreamingEvent;

const createStream = () => {
  let streamController: ReadableStreamDefaultController<Uint8Array> | null =
    null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  });
  return {
    stream,
    controller: () => {
      if (!streamController) {
        throw new Error("Stream controller not initialized");
      }
      return streamController;
    },
  };
};

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
    const chunk =
      `data: ${JSON.stringify(first)}\r\n\r\n` +
      `data: ${JSON.stringify(second)}\n`;

    expect(parseSSEChunk(chunk)).toEqual([first, second]);
  });

  it("joins multiline data before parsing", () => {
    const expected = makeEvent("hello");
    const chunk =
      'data: {"type":"response.output_text.delta",' +
      "\n" +
      'data: "delta":"hello"}\n';

    expect(parseSSEChunk(chunk)).toEqual([expected]);
  });

  it("ignores empty data lines and [DONE]", () => {
    const chunk = "data: \n\n" + "data: [DONE]\n";

    expect(parseSSEChunk(chunk)).toEqual([]);
  });
});

describe("createStreamingResponse cancellation", () => {
  it("aborts fetch when consumer breaks early", async () => {
    const event = makeEvent("hello");
    const encoder = new TextEncoder();
    const { stream, controller } = createStream();
    let aborted = false;

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener("abort", () => {
        aborted = true;
      });
      const ctrl = controller();
      ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      ctrl.close();
      return {
        ok: true,
        status: 200,
        body: stream,
      } as Response;
    });

    const client = createClient({
      baseUrl: "https://example.com/v1",
      apiKey: "test",
      fetch: fetchMock,
    });

    for await (const item of client.createStreamingResponse({
      model: "test",
      input: "hi",
    })) {
      expect(item).toEqual(event);
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(aborted).toBe(true);
  });

  it("aborts fetch when external signal is triggered", async () => {
    const event = makeEvent("hello");
    const encoder = new TextEncoder();
    const { stream, controller } = createStream();
    let aborted = false;

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener("abort", () => {
        aborted = true;
        controller().error(new Error("aborted"));
      });
      return {
        ok: true,
        status: 200,
        body: stream,
      } as Response;
    });

    const client = createClient({
      baseUrl: "https://example.com/v1",
      apiKey: "test",
      fetch: fetchMock,
    });
    const external = new AbortController();

    const streamPromise = (async () => {
      try {
        for await (const item of client.createStreamingResponse(
          { model: "test", input: "hi" },
          external.signal,
        )) {
          expect(item).toEqual(event);
          external.abort();
        }
      } catch {
        // ignore abort-related errors
      }
    })();

    controller().enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

    await streamPromise;
    expect(aborted).toBe(true);
  });

  it("aborts fetch when stream errors", async () => {
    const event = makeEvent("hello");
    const encoder = new TextEncoder();
    const { stream, controller } = createStream();
    let aborted = false;

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener("abort", () => {
        aborted = true;
      });
      const ctrl = controller();
      ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      ctrl.error(new Error("boom"));
      return {
        ok: true,
        status: 200,
        body: stream,
      } as Response;
    });

    const client = createClient({
      baseUrl: "https://example.com/v1",
      apiKey: "test",
      fetch: fetchMock,
    });

    await expect(async () => {
      for await (const _item of client.createStreamingResponse({
        model: "test",
        input: "hi",
      })) {
        // consume until error
      }
    }).rejects.toBeInstanceOf(Error);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(aborted).toBe(true);
  });
});
