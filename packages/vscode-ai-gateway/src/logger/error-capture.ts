/**
 * Error Capture Logger
 *
 * Always-on error logging to globalStorageUri/errors/ for post-hoc forensics.
 * Captures structured error data when requests fail, including SSE event
 * buffers for debugging transient failures.
 *
 * File hierarchy:
 *   {globalStorageUri}/errors/index.jsonl
 *   {globalStorageUri}/errors/{YYYY-MM-DD}/{chatId}.json
 *   {globalStorageUri}/errors/{YYYY-MM-DD}/{chatId}.sse.jsonl
 *
 * Always on for errors — no configuration needed. Pruned by error-capture-prune.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { logger } from "../logger.js";
import { safeJsonStringify } from "../utils/serialize.js";
import { sanitizePathSegment, type SSEEventEntry } from "./investigation.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Error types that can be captured. */
export type ErrorType =
  | "no-response"
  | "timeout"
  | "api-error"
  | "network-error"
  | "unknown";

/**
 * Index entry — one line per error in errors/index.jsonl.
 * Scannable with `jq` to find errors of interest.
 */
export interface ErrorIndexEntry {
  // Timing
  ts: string;
  durationMs: number;

  // Identity
  chatId: string;
  conversationId: string;

  // Model
  model: string;

  // Error info
  errorType: ErrorType;
  errorMessage: string;

  // Context
  eventCount: number;
  textPartCount: number;
  toolCallCount: number;
  isSummarization: boolean;
}

/**
 * Full error capture — written as per-error JSON for detailed forensics.
 * Contains everything needed to reproduce and diagnose the failure.
 */
export interface ErrorCapture {
  // Metadata
  ts: string;
  chatId: string;
  conversationId: string;

  // Error details
  errorType: ErrorType;
  errorMessage: string;

  // Request context
  request: {
    model: string;
    estimatedInputTokens: number;
    messageCount: number;
    messageRoles: string;
    toolCount: number;
    toolNames: string[];
    isSummarization: boolean;
    body: {
      model: string;
      input: unknown[];
      instructions: string | null | undefined;
      tools: unknown[] | undefined;
      toolChoice: string | undefined;
      temperature: number | undefined;
      maxOutputTokens: number | undefined;
      promptCacheKey: string | undefined;
      caching: string | undefined;
    };
  };

  // Response context (partial, whatever was received before failure)
  response: {
    eventCount: number;
    textPartCount: number;
    toolCallCount: number;
    responseId: string | undefined;
    finishReason: string | undefined;
    usage: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens_details?: {
        reasoning_tokens?: number;
      };
    } | null;
  };

  // Timing
  timing: {
    requestStartMs: number;
    ttftMs: number | null;
    durationMs: number;
  };

  // SSE event count (events are in separate .sse.jsonl file)
  sseEventCount: number;
}

/**
 * Data passed to captureError() from the request lifecycle.
 * This is the "input" shape — ErrorCapture is the "output" shape.
 */
export interface ErrorCaptureData {
  // Identity
  chatId: string;
  conversationId: string;

  // Error
  errorType: ErrorType;
  errorMessage: string;

  // Request context (from StartRequestData)
  model: string;
  estimatedInputTokens: number;
  messageCount: number;
  messageRoles: string;
  toolCount: number;
  toolNames: string[];
  isSummarization: boolean;
  requestBody: {
    model: string;
    input: unknown[];
    instructions?: string | null | undefined;
    tools?: unknown[] | undefined;
    tool_choice?: string | undefined;
    temperature?: number | undefined;
    max_output_tokens?: number | undefined;
    prompt_cache_key?: string | undefined;
    caching?: string | undefined;
  };

  // Response context (partial)
  eventCount: number;
  textPartCount: number;
  toolCallCount: number;
  responseId: string | undefined;
  finishReason: string | undefined;
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens_details?: {
      reasoning_tokens?: number;
    };
  } | null;

  // Timing
  requestStartMs: number;
  ttftMs: number | null;
  durationMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Write Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write an error capture to disk.
 *
 * Creates:
 *   {errorsDir}/index.jsonl          — append one line
 *   {errorsDir}/{YYYY-MM-DD}/{chatId}.json  — full capture
 *   {errorsDir}/{YYYY-MM-DD}/{chatId}.sse.jsonl — SSE events (if any)
 */
export async function writeError(
  errorsDir: string,
  capture: ErrorCapture,
  sseBuffer: readonly SSEEventEntry[],
): Promise<void> {
  const dateDir = capture.ts.slice(0, 10); // "YYYY-MM-DD"
  const safeChatId = sanitizePathSegment(capture.chatId);
  const dayDir = path.join(errorsDir, dateDir);

  // Ensure directories exist
  await fs.promises.mkdir(dayDir, { recursive: true });

  // 1. Append to index.jsonl
  const indexEntry: ErrorIndexEntry = {
    ts: capture.ts,
    durationMs: capture.timing.durationMs,
    chatId: capture.chatId,
    conversationId: capture.conversationId,
    model: capture.request.model,
    errorType: capture.errorType,
    errorMessage: capture.errorMessage,
    eventCount: capture.response.eventCount,
    textPartCount: capture.response.textPartCount,
    toolCallCount: capture.response.toolCallCount,
    isSummarization: capture.request.isSummarization,
  };
  const indexPath = path.join(errorsDir, "index.jsonl");
  await fs.promises.appendFile(
    indexPath,
    `${safeJsonStringify(indexEntry)}\n`,
    "utf8",
  );

  // 2. Write per-error JSON
  const errorJsonPath = path.join(dayDir, `${safeChatId}.json`);
  await fs.promises.writeFile(
    errorJsonPath,
    safeJsonStringify(capture, 2),
    "utf8",
  );

  // 3. Write SSE buffer (if any events were captured)
  if (sseBuffer.length > 0) {
    const ssePath = path.join(dayDir, `${safeChatId}.sse.jsonl`);
    const sseLines = sseBuffer.map((e) => safeJsonStringify(e)).join("\n");
    await fs.promises.writeFile(ssePath, `${sseLines}\n`, "utf8");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ErrorCaptureLogger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Always-on error logger that writes to globalStorageUri/errors/.
 *
 * Usage:
 *   const errorLogger = new ErrorCaptureLogger(context.globalStorageUri);
 *   await errorLogger.captureError(data, sseBuffer);
 */
export class ErrorCaptureLogger {
  private readonly errorsDir: string;

  constructor(globalStorageUri: vscode.Uri) {
    this.errorsDir = path.join(globalStorageUri.fsPath, "errors");
  }

  /**
   * Capture an error with full context for forensics.
   * Fire-and-forget — errors during write are logged but never thrown.
   */
  async captureError(
    data: ErrorCaptureData,
    sseBuffer: readonly SSEEventEntry[],
  ): Promise<void> {
    try {
      const capture = this.buildCapture(data, sseBuffer.length);
      await writeError(this.errorsDir, capture, sseBuffer);
      logger.info(
        `[ErrorCapture] Captured ${data.errorType} error for chat ${data.chatId}`,
      );
    } catch (err) {
      // Fire-and-forget — never let error logging crash the extension
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.error(`[ErrorCapture] Failed to write error log: ${message}`);
    }
  }

  /** Get the errors directory path (for pruning and export). */
  getErrorsDir(): string {
    return this.errorsDir;
  }

  private buildCapture(
    data: ErrorCaptureData,
    sseEventCount: number,
  ): ErrorCapture {
    return {
      ts: new Date().toISOString(),
      chatId: data.chatId,
      conversationId: data.conversationId,
      errorType: data.errorType,
      errorMessage: data.errorMessage,
      request: {
        model: data.model,
        estimatedInputTokens: data.estimatedInputTokens,
        messageCount: data.messageCount,
        messageRoles: data.messageRoles,
        toolCount: data.toolCount,
        toolNames: data.toolNames,
        isSummarization: data.isSummarization,
        body: {
          model: data.requestBody.model,
          input: data.requestBody.input,
          instructions: data.requestBody.instructions ?? null,
          tools: data.requestBody.tools,
          toolChoice: data.requestBody.tool_choice,
          temperature: data.requestBody.temperature,
          maxOutputTokens: data.requestBody.max_output_tokens,
          promptCacheKey: data.requestBody.prompt_cache_key,
          caching: data.requestBody.caching,
        },
      },
      response: {
        eventCount: data.eventCount,
        textPartCount: data.textPartCount,
        toolCallCount: data.toolCallCount,
        responseId: data.responseId,
        finishReason: data.finishReason,
        usage: data.usage,
      },
      timing: {
        requestStartMs: data.requestStartMs,
        ttftMs: data.ttftMs,
        durationMs: data.durationMs,
      },
      sseEventCount,
    };
  }
}
