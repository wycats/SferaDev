import * as fs from "node:fs";
import * as path from "node:path";
import type {
  CreateResponseBody,
  StreamingEvent,
  Usage,
} from "openresponses-client";
import { safeJsonStringify } from "../utils/serialize.js";
import { IndexWriter } from "./index-writer";
import { SessionManager } from "./session-manager";
import type { LogEntry } from "./types";

export interface RequestLoggerOptions {
  baseDirectory: string;
  sessionId: string;
  chatId: string;
  modelId?: string;
  captureRequests: boolean;
  captureEvents: boolean;
  indexWriter?: IndexWriter;
  sessionManager?: SessionManager;
}

export interface RequestSummary {
  responseId?: string;
  finishReason?: string;
  usage?: Usage;
  textParts?: number;
  toolCallsEmitted?: number;
  eventCount?: number;
  error?: string;
}

export class RequestLogger {
  private readonly baseDirectory: string;
  private readonly sessionId: string;
  private readonly chatId: string;
  private readonly modelId: string | undefined;
  private readonly captureRequests: boolean;
  private readonly captureEvents: boolean;
  private readonly indexWriter: IndexWriter;
  private readonly sessionManager: SessionManager;
  private readonly startedAt: Date;
  private eventSeq = 0;
  private eventCount = 0;
  private chatStarted = false;

  constructor(options: RequestLoggerOptions) {
    this.baseDirectory = options.baseDirectory;
    this.sessionId = options.sessionId;
    this.chatId = options.chatId;
    this.modelId = options.modelId;
    this.captureRequests = options.captureRequests;
    this.captureEvents = options.captureEvents;
    this.indexWriter = options.indexWriter ?? new IndexWriter();
    this.sessionManager =
      options.sessionManager ?? new SessionManager(this.indexWriter);
    this.startedAt = new Date();
  }

  private get sessionDirectory(): string {
    return this.sessionManager.getSessionDirectory(this.baseDirectory);
  }

  private get chatDirectory(): string {
    return path.join(this.sessionDirectory, this.chatId);
  }

  private get sessionIndexPath(): string {
    return path.join(this.sessionDirectory, "session.jsonl");
  }

  private get chatIndexPath(): string {
    return path.join(this.chatDirectory, "chat.jsonl");
  }

  private get requestPath(): string {
    return path.join(this.chatDirectory, "request.json");
  }

  private get responsePath(): string {
    return path.join(this.chatDirectory, "response.json");
  }

  private get eventsPath(): string {
    return path.join(this.chatDirectory, "events.jsonl");
  }

  private get errorsIndexPath(): string {
    return path.join(this.baseDirectory, "errors.jsonl");
  }

  private async ensureChatDirectory(): Promise<boolean> {
    const sessionDirectory = await this.sessionManager.ensureSessionDirectory(
      this.baseDirectory,
    );
    if (!sessionDirectory) return false;
    try {
      await fs.promises.mkdir(this.chatDirectory, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  private toRelativePath(
    targetPath: string,
    basePath = this.sessionDirectory,
  ): string {
    return path.relative(basePath, targetPath).split(path.sep).join("/");
  }

  private async appendSessionEntry(entry: LogEntry): Promise<void> {
    await this.indexWriter.append(this.sessionIndexPath, entry);
  }

  private async appendChatEntry(entry: LogEntry): Promise<void> {
    await this.indexWriter.append(this.chatIndexPath, entry);
  }

  async logChatStart(): Promise<void> {
    if (this.chatStarted) return;
    this.chatStarted = true;

    const timestamp = new Date().toISOString();
    await this.appendSessionEntry({
      timestamp,
      type: "chat_start",
      chatId: this.chatId,
      model: this.modelId,
    });
    await this.appendChatEntry({
      timestamp,
      type: "chat_start",
      chatId: this.chatId,
      model: this.modelId,
    });
  }

  async logRequest(requestBody: CreateResponseBody): Promise<void> {
    if (!this.captureRequests) return;
    if (!(await this.ensureChatDirectory())) return;

    try {
      await fs.promises.writeFile(
        this.requestPath,
        JSON.stringify(requestBody, null, 2),
        "utf8",
      );

      const timestamp = new Date().toISOString();
      const relativePath = this.toRelativePath(this.requestPath);
      await this.appendSessionEntry({
        timestamp,
        type: "request_sent",
        chatId: this.chatId,
        file: relativePath,
      });
      await this.appendChatEntry({
        timestamp,
        type: "request_sent",
        file: "request.json",
      });
    } catch {
      // Ignore errors
    }
  }

  async recordEvent(event: StreamingEvent): Promise<void> {
    if (!this.captureEvents) return;
    if (!(await this.ensureChatDirectory())) return;

    try {
      this.eventSeq += 1;
      this.eventCount += 1;
      const timestamp = new Date().toISOString();
      await fs.promises.appendFile(
        this.eventsPath,
        `${safeJsonStringify({
          seq: this.eventSeq,
          type: event.type,
          timestamp,
          data: event,
        })}\n`,
        "utf8",
      );

      await this.appendChatEntry({
        timestamp,
        type: "event",
        event: event.type,
        seq: this.eventSeq,
      });
    } catch {
      // Ignore errors
    }
  }

  async logResponse(summary: RequestSummary): Promise<void> {
    if (!this.captureRequests) return;
    if (!(await this.ensureChatDirectory())) return;

    try {
      const completedAt = new Date();
      const durationMs = completedAt.getTime() - this.startedAt.getTime();
      const response = {
        responseId: summary.responseId,
        model: this.modelId,
        finishReason: summary.finishReason,
        usage: summary.usage,
        timing: {
          startedAt: this.startedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          durationMs,
        },
        summary: {
          textParts: summary.textParts ?? 0,
          toolCallsEmitted: summary.toolCallsEmitted ?? 0,
          eventCount: summary.eventCount ?? this.eventCount,
        },
        error: summary.error ?? null,
      };

      await fs.promises.writeFile(
        this.responsePath,
        JSON.stringify(response, null, 2),
        "utf8",
      );

      const timestamp = completedAt.toISOString();
      await this.appendSessionEntry({
        timestamp,
        type: "response_completed",
        chatId: this.chatId,
        file: this.toRelativePath(this.responsePath),
        error: summary.error ?? null,
      });
      await this.appendChatEntry({
        timestamp,
        type: "response_completed",
        file: "response.json",
        error: summary.error ?? null,
      });

      if (summary.error) {
        await this.logError(summary.error, undefined);
      }
    } catch {
      // Ignore errors
    }
  }

  async logError(errorMessage: string, errorCode?: string): Promise<void> {
    try {
      const timestamp = new Date().toISOString();
      const errorEntry = {
        sessionId: this.sessionId,
        chatId: this.chatId,
        timestamp,
        error: errorMessage,
        errorCode,
        path: this.toRelativePath(this.chatDirectory, this.baseDirectory),
      };

      await this.indexWriter.append(this.errorsIndexPath, errorEntry);
      await this.appendSessionEntry({
        timestamp,
        type: "error",
        chatId: this.chatId,
        error: errorMessage,
        errorCode,
      });
      await this.appendChatEntry({
        timestamp,
        type: "error",
        error: errorMessage,
        errorCode,
      });
    } catch {
      // Ignore errors
    }
  }
}
