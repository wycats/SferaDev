/**
 * Investigation Logging System (RFC 00065)
 *
 * Hierarchical, investigation-scoped logging for debugging request lifecycles.
 * Replaces ad-hoc logging (validation-log, forensic-capture, debug-utils).
 *
 * File hierarchy:
 *   .logs/{{investigation}}/index.jsonl
 *   .logs/{{investigation}}/{{conversationId}}/messages.jsonl
 *   .logs/{{investigation}}/{{conversationId}}/messages/{{chatId}}.json
 *   .logs/{{investigation}}/{{conversationId}}/messages/{{chatId}}.sse.jsonl
 *
 * Detail levels control what gets written:
 *   off      → nothing
 *   index    → index.jsonl only
 *   messages → index + messages.jsonl + per-chat .json
 *   full     → everything including SSE event streams
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { exec } from "node:child_process";
import * as vscode from "vscode";

import type { InvestigationDetail } from "../config.js";
import { logger } from "../logger.js";
import { safeJsonStringify } from "../utils/serialize.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Index entry — one line per request in the investigation's index.jsonl.
 * This is the table of contents: scannable with `jq` to find conversations
 * and requests of interest.
 */
export interface IndexEntry {
  // Timing
  ts: string;
  durationMs: number;
  ttftMs: number | null;

  // Identity
  conversationId: string;
  chatId: string;
  responseId: string | null;

  // Model
  model: string;

  // Request summary
  messageCount: number;
  toolCount: number;
  estimatedInputTokens: number;

  // Response summary
  status: "success" | "error" | "cancelled" | "timeout";
  finishReason: string | null;
  actualInputTokens: number | null;
  actualOutputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;

  // Token accuracy (replaces validation-log.ts)
  tokenDelta: number | null;
  tokenDeltaPct: number | null;

  // Flags
  isSummarization: boolean;
}

/**
 * Message summary — one line per request in the conversation's messages.jsonl.
 * More context than the index, enough to understand the request without
 * reading the full body.
 */
export interface MessageSummary {
  ts: string;
  conversationId: string;
  chatId: string;
  responseId: string | null;

  // Request metadata
  model: string;
  systemPromptLength: number | null;
  messageRoles: string;
  toolNames: string[];

  // Token breakdown
  estimate: {
    total: number;
  };
  actual: {
    input: number | null;
    output: number | null;
    cached: number | null;
    reasoning: number | null;
  };

  // Response metadata
  status: "success" | "error" | "cancelled" | "timeout";
  finishReason: string | null;
  textPartCount: number;
  toolCallCount: number;
  eventCount: number;
  durationMs: number;
  ttftMs: number | null;

  // Error info
  error: string | null;
}

/**
 * Full request capture — the complete picture of a single request.
 * Written as messages/{{chatId}}.json at `messages` and `full` levels.
 */
export interface FullRequestCapture {
  ts: string;
  conversationId: string;
  chatId: string;
  responseId: string | null;

  // Request (what we sent to OpenResponses)
  request: {
    model: string;
    input: unknown[];
    instructions: string | null;
    tools: unknown[];
    toolChoice: string | undefined;
    temperature: number | undefined;
    maxOutputTokens: number | undefined;
    promptCacheKey: string | undefined;
    caching: string | undefined;
  };

  // Response
  response: {
    status: string;
    finishReason: string | null;
    usage: unknown;
    error: string | null;
  };

  // Timing
  timing: {
    startMs: number;
    ttftMs: number | null;
    endMs: number;
    durationMs: number;
  };

  // Flags
  isSummarization: boolean;
}

/**
 * SSE event entry — one line per event in messages/{{chatId}}.sse.jsonl.
 * Written at `full` level only.
 */
export interface SSEEventEntry {
  seq: number;
  ts: string;
  elapsed: number;
  type: string;
  payload: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE Recorder Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal interface for recording SSE events. Passed into the stream
 * processing loop — intentionally NOT the full InvestigationLogger.
 *
 * Implementations buffer events in memory and flush during completeRequest().
 */
export interface InvestigationSSERecorder {
  /** Record a single SSE event. Called synchronously per event. */
  recordEvent(seq: number, type: string, payload: unknown): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Data passed to logger from the request lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/** Data available at request start (before streaming begins). */
export interface StartRequestData {
  conversationId: string;
  chatId: string;
  model: string;
  estimatedInputTokens: number;
  messageCount: number;
  messageRoles: string;
  toolCount: number;
  toolNames: string[];
  isSummarization: boolean;

  // Full request body (captured at messages/full level)
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
}

/** Data available at request completion. */
export interface CompleteRequestData {
  status: "success" | "error" | "cancelled" | "timeout";
  finishReason: string | null;
  responseId: string | null;
  error: string | null;
  durationMs: number;
  ttftMs: number | null;
  eventCount: number;
  textPartCount: number;
  toolCallCount: number;
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens_details?: {
      reasoning_tokens?: number;
    };
  } | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE Recorder Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Buffers SSE events in memory. Flushed to disk in completeRequest().
 */
class SSERecorderImpl implements InvestigationSSERecorder {
  private readonly events: SSEEventEntry[] = [];
  private readonly requestStartMs: number;

  constructor(requestStartMs: number) {
    this.requestStartMs = requestStartMs;
  }

  recordEvent(seq: number, type: string, payload: unknown): void {
    this.events.push({
      seq,
      ts: new Date().toISOString(),
      elapsed: performance.now() - this.requestStartMs,
      type,
      payload,
    });
  }

  getEvents(): readonly SSEEventEntry[] {
    return this.events;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gitignore Warning
// ─────────────────────────────────────────────────────────────────────────────

/** Tracks directories we've already warned about this session. */
const warnedDirectories = new Set<string>();

/**
 * Check if investigation logs directory is inside a git repo but not gitignored.
 * Shows a once-per-session-per-directory information message.
 */
export async function checkGitignoreWarning(logDir: string): Promise<void> {
  if (warnedDirectories.has(logDir)) return;
  warnedDirectories.add(logDir);

  try {
    // Check if we're inside a git repo
    const isGitRepo = await new Promise<boolean>((resolve) => {
      exec("git rev-parse --git-dir", { cwd: logDir }, (error) => {
        resolve(!error);
      });
    });

    if (!isGitRepo) return;

    // Find the repo root to check .gitignore
    const repoRoot = await new Promise<string | null>((resolve) => {
      exec(
        "git rev-parse --show-toplevel",
        { cwd: logDir },
        (error, stdout) => {
          resolve(error ? null : stdout.trim());
        },
      );
    });

    if (!repoRoot) return;

    // Check if the logs directory is ignored
    const logsRelative = path.relative(repoRoot, logDir);
    const isIgnored = await new Promise<boolean>((resolve) => {
      exec(
        `git check-ignore -q ${JSON.stringify(logsRelative)}`,
        { cwd: repoRoot },
        (error) => {
          // exit 0 = ignored, exit 1 = not ignored
          resolve(!error);
        },
      );
    });

    if (!isIgnored) {
      void vscode.window.showInformationMessage(
        `Investigation logging captures request/response data. Consider adding "${logsRelative}/" to your .gitignore.`,
      );
    }
  } catch {
    // Gitignore check is best-effort — never interfere with the extension
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Path Safety
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sanitize a string for use as a path segment. Prevents path traversal
 * and removes characters that are problematic on common filesystems.
 *
 * - Strips path separators (/, \)
 * - Strips parent directory references (..)
 * - Strips control characters and filesystem-unsafe chars
 * - Falls back to "unknown" if the result is empty
 */
export function sanitizePathSegment(segment: string): string {
  const sanitized = segment
    // Remove path separators
    .replace(/[/\\]/g, "_")
    // Remove parent directory traversals
    .replace(/\.\./g, "_")
    // Remove filesystem-unsafe characters (: * ? " < > |)
    // eslint-disable-next-line no-control-regex -- Intentional: sanitizing filesystem-unsafe control characters
    .replace(/[:<>"|?*\x00-\x1f]/g, "_")
    // Collapse multiple underscores
    .replace(/_+/g, "_")
    // Trim leading/trailing underscores and dots
    .replace(/^[_.]+|[_.]+$/g, "");

  return sanitized || "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────
// Investigation Logger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the investigation logs directory from workspace configuration.
 *
 * Uses the same pattern as Logger.getResolvedLogDirectory():
 * - Absolute paths use as-is
 * - Relative paths resolve against first workspace folder
 */
function resolveLogDirectory(): string | null {
  const logFileDirectory =
    vscode.workspace
      .getConfiguration("vercel.ai")
      .get<string>("logging.fileDirectory") ?? ".logs";

  if (!logFileDirectory) return null;

  if (path.isAbsolute(logFileDirectory)) {
    return logFileDirectory;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  const firstFolder = workspaceFolders?.[0];
  if (firstFolder) {
    return path.join(firstFolder.uri.fsPath, logFileDirectory);
  }

  return null;
}

/**
 * Per-request handle returned by InvestigationLogger.startRequest().
 *
 * Each request gets its own handle with snapshotted config and isolated state,
 * so concurrent requests never interfere with each other.
 */
export class InvestigationRequestHandle {
  private readonly startData: StartRequestData;
  private readonly sseRecorder: SSERecorderImpl | null;
  private readonly requestStartMs: number;
  private readonly detail: InvestigationDetail;
  private readonly investigationName: string;

  /** @internal — use InvestigationLogger.startRequest() */
  constructor(
    startData: StartRequestData,
    detail: InvestigationDetail,
    investigationName: string,
    requestStartMs: number,
    sseRecorder: SSERecorderImpl | null,
  ) {
    this.startData = startData;
    this.detail = detail;
    this.investigationName = investigationName;
    this.requestStartMs = requestStartMs;
    this.sseRecorder = sseRecorder;
  }

  /** The SSE recorder for this request, or null if detail < full. */
  get recorder(): InvestigationSSERecorder | null {
    return this.sseRecorder;
  }

  /**
   * Complete the request and flush all data to disk.
   * This is fire-and-forget — errors are logged but never thrown.
   */
  async complete(result: CompleteRequestData): Promise<void> {
    try {
      await this.flush(result);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown error during flush";
      logger.error(`[InvestigationLogger] Failed to write logs: ${message}`);
      void vscode.window.showErrorMessage(
        `Investigation logging failed: ${message}. Check the Output Channel for details.`,
      );
    }
  }

  private async flush(result: CompleteRequestData): Promise<void> {
    const logDir = resolveLogDirectory();
    if (!logDir) return;

    const investigationDir = path.join(logDir, this.investigationName);
    const safeConversationId = sanitizePathSegment(
      this.startData.conversationId,
    );
    const safeChatId = sanitizePathSegment(this.startData.chatId);
    const conversationDir = path.join(investigationDir, safeConversationId);
    const messagesDir = path.join(conversationDir, "messages");

    const ts = new Date().toISOString();

    // Compute token accuracy
    const actualInput = result.usage?.input_tokens ?? null;
    const tokenDelta =
      actualInput !== null
        ? this.startData.estimatedInputTokens - actualInput
        : null;
    const tokenDeltaPct =
      actualInput !== null && actualInput > 0
        ? ((this.startData.estimatedInputTokens - actualInput) / actualInput) *
          100
        : null;

    // Cached tokens (Anthropic-style)
    const cachedTokens = result.usage?.cache_read_input_tokens ?? null;

    const reasoningTokens =
      result.usage?.output_tokens_details?.reasoning_tokens ?? null;

    // ── Index entry (all non-off levels) ──────────────────────────────
    const indexEntry: IndexEntry = {
      ts,
      durationMs: result.durationMs,
      ttftMs: result.ttftMs,
      conversationId: this.startData.conversationId,
      chatId: this.startData.chatId,
      responseId: result.responseId,
      model: this.startData.model,
      messageCount: this.startData.messageCount,
      toolCount: this.startData.toolCount,
      estimatedInputTokens: this.startData.estimatedInputTokens,
      status: result.status,
      finishReason: result.finishReason,
      actualInputTokens: actualInput,
      actualOutputTokens: result.usage?.output_tokens ?? null,
      cachedTokens,
      reasoningTokens,
      tokenDelta,
      tokenDeltaPct,
      isSummarization: this.startData.isSummarization,
    };

    // Ensure investigation directory exists
    await fs.promises.mkdir(investigationDir, { recursive: true });

    // Check gitignore on first write
    void checkGitignoreWarning(investigationDir);

    // Write index entry
    const indexPath = path.join(investigationDir, "index.jsonl");
    await fs.promises.appendFile(
      indexPath,
      `${safeJsonStringify(indexEntry)}\n`,
      "utf8",
    );

    if (this.detail === "index") return;

    // ── Message summary (messages/full levels) ────────────────────────
    await fs.promises.mkdir(messagesDir, { recursive: true });

    const messageSummary: MessageSummary = {
      ts,
      conversationId: this.startData.conversationId,
      chatId: this.startData.chatId,
      responseId: result.responseId,
      model: this.startData.model,
      systemPromptLength:
        this.startData.requestBody.instructions?.length ?? null,
      messageRoles: this.startData.messageRoles,
      toolNames: this.startData.toolNames.slice(0, 10),
      estimate: {
        total: this.startData.estimatedInputTokens,
      },
      actual: {
        input: actualInput,
        output: result.usage?.output_tokens ?? null,
        cached: cachedTokens,
        reasoning: reasoningTokens,
      },
      status: result.status,
      finishReason: result.finishReason,
      textPartCount: result.textPartCount,
      toolCallCount: result.toolCallCount,
      eventCount: result.eventCount,
      durationMs: result.durationMs,
      ttftMs: result.ttftMs,
      error: result.error,
    };

    const messagesJsonlPath = path.join(conversationDir, "messages.jsonl");
    await fs.promises.appendFile(
      messagesJsonlPath,
      `${safeJsonStringify(messageSummary)}\n`,
      "utf8",
    );

    // ── Full request capture ──────────────────────────────────────────
    const fullCapture: FullRequestCapture = {
      ts,
      conversationId: this.startData.conversationId,
      chatId: this.startData.chatId,
      responseId: result.responseId,
      request: {
        model: this.startData.requestBody.model,
        input: this.startData.requestBody.input,
        instructions: this.startData.requestBody.instructions ?? null,
        tools: this.startData.requestBody.tools ?? [],
        toolChoice: this.startData.requestBody.tool_choice,
        temperature: this.startData.requestBody.temperature,
        maxOutputTokens: this.startData.requestBody.max_output_tokens,
        promptCacheKey: this.startData.requestBody.prompt_cache_key,
        caching: this.startData.requestBody.caching,
      },
      response: {
        status: result.status,
        finishReason: result.finishReason,
        usage: result.usage,
        error: result.error,
      },
      timing: {
        startMs: this.requestStartMs,
        ttftMs: result.ttftMs,
        endMs: this.requestStartMs + result.durationMs,
        durationMs: result.durationMs,
      },
      isSummarization: this.startData.isSummarization,
    };

    const chatJsonPath = path.join(messagesDir, `${safeChatId}.json`);
    await fs.promises.writeFile(
      chatJsonPath,
      safeJsonStringify(fullCapture, 2),
      "utf8",
    );

    if (this.detail !== "full") return;

    // ── SSE events (full level only) ──────────────────────────────────
    if (this.sseRecorder) {
      const events = this.sseRecorder.getEvents();
      if (events.length > 0) {
        const sseJsonlPath = path.join(messagesDir, `${safeChatId}.sse.jsonl`);
        const sseLines = events.map((e) => safeJsonStringify(e)).join("\n");
        await fs.promises.writeFile(sseJsonlPath, `${sseLines}\n`, "utf8");
      }
    }
  }
}

/**
 * InvestigationLogger — factory for per-request logging handles.
 *
 * Lifecycle:
 *   1. Create a single InvestigationLogger (shared across requests)
 *   2. Call startRequest() per request → returns a handle (or null if off)
 *   3. Use the handle's recorder for SSE events
 *   4. Call handle.complete() when the request finishes
 *
 * Each handle snapshots the config at creation time, so changing settings
 * mid-request won't cause inconsistencies. Concurrent requests each get
 * their own handle with isolated state.
 */
export class InvestigationLogger {
  /**
   * Begin tracking a request. Returns a per-request handle with an SSE
   * recorder, or null if investigation logging is disabled.
   *
   * The detail level and investigation name are snapshotted at this point.
   */
  startRequest(data: StartRequestData): InvestigationRequestHandle | null {
    const config = vscode.workspace.getConfiguration("vercel.ai");
    const detail =
      config.get<InvestigationDetail>("investigation.detail") ?? "off";
    if (detail === "off") return null;

    const investigationName =
      config.get<string>("investigation.name") ?? "default";
    const requestStartMs = performance.now();
    const sseRecorder =
      detail === "full" ? new SSERecorderImpl(requestStartMs) : null;

    return new InvestigationRequestHandle(
      data,
      detail,
      investigationName,
      requestStartMs,
      sseRecorder,
    );
  }
}
