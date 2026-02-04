/**
 * OpenResponses Client
 *
 * A minimal TypeScript client for the OpenResponses API with streaming support.
 */

import type {
  CreateResponseBody as CreateResponseBodyType,
  ErrorStreamingEvent,
  ResponseCompletedStreamingEvent,
  ResponseContentPartAddedStreamingEvent,
  ResponseContentPartDoneStreamingEvent,
  ResponseCreatedStreamingEvent,
  ResponseFailedStreamingEvent,
  ResponseFunctionCallArgumentsDeltaStreamingEvent,
  ResponseFunctionCallArgumentsDoneStreamingEvent,
  ResponseIncompleteStreamingEvent,
  ResponseInProgressStreamingEvent,
  ResponseOutputItemAddedStreamingEvent,
  ResponseOutputItemDoneStreamingEvent,
  ResponseOutputTextAnnotationAddedStreamingEvent,
  ResponseOutputTextDeltaStreamingEvent,
  ResponseOutputTextDoneStreamingEvent,
  ResponseQueuedStreamingEvent,
  ResponseReasoningDeltaStreamingEvent,
  ResponseReasoningDoneStreamingEvent,
  ResponseReasoningSummaryDeltaStreamingEvent,
  ResponseReasoningSummaryDoneStreamingEvent,
  ResponseReasoningSummaryPartAddedStreamingEvent,
  ResponseReasoningSummaryPartDoneStreamingEvent,
  ResponseRefusalDeltaStreamingEvent,
  ResponseRefusalDoneStreamingEvent,
  ResponseResource as ResponseResourceType,
  Usage as UsageType,
} from "./generated/types/index.ts";

// Re-export commonly used types for convenience
export type CreateResponseBody = CreateResponseBodyType;
export type ResponseResource = ResponseResourceType;
export type Usage = UsageType;

// All possible streaming event types
export type StreamingEvent =
  | ResponseCreatedStreamingEvent
  | ResponseQueuedStreamingEvent
  | ResponseInProgressStreamingEvent
  | ResponseCompletedStreamingEvent
  | ResponseFailedStreamingEvent
  | ResponseIncompleteStreamingEvent
  | ResponseOutputItemAddedStreamingEvent
  | ResponseOutputItemDoneStreamingEvent
  | ResponseReasoningSummaryPartAddedStreamingEvent
  | ResponseReasoningSummaryPartDoneStreamingEvent
  | ResponseContentPartAddedStreamingEvent
  | ResponseContentPartDoneStreamingEvent
  | ResponseOutputTextDeltaStreamingEvent
  | ResponseOutputTextDoneStreamingEvent
  | ResponseRefusalDeltaStreamingEvent
  | ResponseRefusalDoneStreamingEvent
  | ResponseReasoningDeltaStreamingEvent
  | ResponseReasoningDoneStreamingEvent
  | ResponseReasoningSummaryDeltaStreamingEvent
  | ResponseReasoningSummaryDoneStreamingEvent
  | ResponseOutputTextAnnotationAddedStreamingEvent
  | ResponseFunctionCallArgumentsDeltaStreamingEvent
  | ResponseFunctionCallArgumentsDoneStreamingEvent
  | ErrorStreamingEvent;

// Convenience type aliases for specific events
export type ResponseCompletedEvent = ResponseCompletedStreamingEvent;
export type ResponseFailedEvent = ResponseFailedStreamingEvent;
export type TextDeltaEvent = ResponseOutputTextDeltaStreamingEvent;
export type ErrorEvent = ErrorStreamingEvent;

/**
 * Logging callback for tracing API requests and responses
 */
export type LogCallback = (
  level: "trace" | "debug" | "info" | "warn" | "error",
  message: string,
  data?: unknown,
) => void;

/**
 * Client configuration options
 */
export interface ClientOptions {
  /**
   * Base URL for the OpenResponses API.
   *
   * NOTE: This client appends `/responses` to the base URL, so it must include
   * the `/v1` segment (e.g. `https://example.com/v1`).
   */
  baseUrl: string;
  /** API key or bearer token for authentication */
  apiKey: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Custom fetch implementation (for testing or environments without global fetch) */
  fetch?: typeof globalThis.fetch;
  /** Optional logging callback for request/response tracing */
  log?: LogCallback;
}

/**
 * Error thrown when the API returns an error response
 */
export class OpenResponsesError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "OpenResponsesError";
  }
}

/**
 * Creates an OpenResponses API client
 */
export function createClient(options: ClientOptions) {
  const {
    baseUrl,
    apiKey,
    timeout = 30000,
    fetch: fetchImpl = globalThis.fetch,
    log = () => {
      /* no-op */
    },
  } = options;

  const trace = (message: string, data?: unknown) => {
    log("trace", message, data);
  };
  const debug = (message: string, data?: unknown) => {
    log("debug", message, data);
  };

  /**
   * Create a response (non-streaming)
   */
  async function createResponse(
    body: CreateResponseBody,
  ): Promise<ResponseResource> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeout);
    const url = `${baseUrl}/responses`;
    const requestBody = { ...body, stream: false };

    trace("[OpenResponses] Request URL", url);
    trace("[OpenResponses] Request body", requestBody);

    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      trace("[OpenResponses] Response status", response.status);

      if (!response.ok) {
        const errorBody = await response.text();
        trace("[OpenResponses] Error response body", errorBody);
        let parsed: {
          error?: {
            message?: string;
            code?: string;
            param?: string;
            type?: string;
          };
        } = {};
        try {
          parsed = JSON.parse(errorBody) as typeof parsed;
        } catch {
          // ignore parse errors
        }
        const errorMsg = parsed.error?.param
          ? `${parsed.error.message ?? `HTTP ${response.status.toString()}`} (param: ${parsed.error.param})`
          : (parsed.error?.message ?? `HTTP ${response.status.toString()}`);
        throw new OpenResponsesError(
          errorMsg,
          response.status,
          parsed.error?.code,
          parsed,
        );
      }

      return (await response.json()) as ResponseResource;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Create a streaming response
   *
   * Yields streaming events as they arrive. The final `response.completed` event
   * contains the full ResponseResource with usage data.
   */
  async function* createStreamingResponse(
    body: CreateResponseBody,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamingEvent, void, unknown> {
    const controller = new AbortController();
    const url = `${baseUrl}/responses`;
    const requestBody = { ...body, stream: true };

    trace("[OpenResponses] Streaming request URL", url);
    trace("[OpenResponses] Streaming request body", requestBody);

    // Link external signal to our controller
    if (signal) {
      signal.addEventListener("abort", () => {
        controller.abort();
      });
    }

    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    trace("[OpenResponses] Streaming response status", response.status);

    if (!response.ok) {
      const errorBody = await response.text();
      trace("[OpenResponses] Streaming error body", errorBody);
      let parsed: {
        error?: {
          message?: string;
          code?: string;
          param?: string;
          type?: string;
        };
      } = {};
      try {
        parsed = JSON.parse(errorBody) as typeof parsed;
      } catch {
        // ignore parse errors
      }
      // Include param info if available to help debug validation errors
      const errorMsg = parsed.error?.param
        ? `${parsed.error.message ?? `HTTP ${response.status.toString()}`} (param: ${parsed.error.param})`
        : (parsed.error?.message ?? `HTTP ${response.status.toString()}`);
      throw new OpenResponsesError(
        errorMsg,
        response.status,
        parsed.error?.code,
        parsed,
      );
    }

    if (!response.body) {
      throw new OpenResponsesError("Response body is null", 0, "NO_BODY");
    }

    let eventCount = 0;
    for await (const event of parseSSEStream(response.body)) {
      eventCount++;
      trace(`[OpenResponses] SSE event #${eventCount.toString()}`, event);
      yield event;
    }
    debug(
      `[OpenResponses] Stream completed with ${eventCount.toString()} events`,
    );
  }

  return {
    createResponse,
    createStreamingResponse,
  };
}

/**
 * Parse a Server-Sent Events stream into typed events
 */
async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamingEvent, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        // Process any remaining data in buffer
        if (buffer.trim()) {
          for (const event of parseSSEChunk(buffer)) {
            yield event;
          }
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");

      // SSE events are separated by double newlines
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        for (const event of parseSSEChunk(chunk)) {
          yield event;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse a single SSE chunk into typed events.
 * A chunk may contain multiple data lines (e.g., when network buffers combine events).
 * Returns an array of all parsed events.
 */
export function parseSSEChunk(chunk: string): StreamingEvent[] {
  const events: StreamingEvent[] = [];
  // SSE format: "event: name\ndata: {...}\n" or just "data: {...}\n"
  const lines = chunk.split("\n");
  let dataBuffer: string[] = [];

  const flushDataBuffer = () => {
    if (dataBuffer.length === 0) return;
    const jsonStr = dataBuffer.join("\n");
    dataBuffer = [];

    // Handle [DONE] signal (OpenAI convention) - skip silently
    if (jsonStr.trim() === "[DONE]") {
      return;
    }

    // Skip empty data lines
    if (!jsonStr.trim()) {
      return;
    }

    try {
      const parsed = JSON.parse(jsonStr) as StreamingEvent;
      events.push(parsed);
    } catch (e) {
      // Log parse failure with context but don't throw
      const preview =
        jsonStr.length > 100 ? jsonStr.slice(0, 100) + "..." : jsonStr;
      console.warn(
        `[OpenResponses] Failed to parse SSE data: ${e instanceof Error ? e.message : String(e)}. Data: ${preview}`,
      );
    }
  };

  for (const line of lines) {
    if (line.startsWith("data: ")) {
      dataBuffer.push(line.slice(6)); // Remove "data: " prefix
      continue;
    }
    flushDataBuffer();
    // Note: We intentionally ignore "event:" lines since OpenResponses uses
    // the "type" field inside the JSON payload for event discrimination
  }

  flushDataBuffer();

  return events;
}

// Type guards for common event types
export function isTextDelta(event: StreamingEvent): event is TextDeltaEvent {
  return event.type === "response.output_text.delta";
}

export function isResponseCompleted(
  event: StreamingEvent,
): event is ResponseCompletedEvent {
  return event.type === "response.completed";
}

export function isResponseFailed(
  event: StreamingEvent,
): event is ResponseFailedEvent {
  return event.type === "response.failed";
}

export function isError(event: StreamingEvent): event is ErrorEvent {
  return event.type === "error";
}
