import * as fs from "node:fs";
import * as path from "node:path";
import { IndexWriter } from "./index-writer";
import type { SessionInfo } from "./types";

function formatTimestampComponent(value: number, length = 2): string {
  return value.toString().padStart(length, "0");
}

function generateSessionId(): string {
  const now = new Date();
  const year = formatTimestampComponent(now.getUTCFullYear(), 4);
  const month = formatTimestampComponent(now.getUTCMonth() + 1);
  const day = formatTimestampComponent(now.getUTCDate());
  const hours = formatTimestampComponent(now.getUTCHours());
  const minutes = formatTimestampComponent(now.getUTCMinutes());
  const seconds = formatTimestampComponent(now.getUTCSeconds());
  const random = Math.random().toString(36).slice(2, 10);

  return `${year}${month}${day}-${hours}${minutes}${seconds}-${random}`;
}

export class SessionManager {
  private readonly sessionId: string;
  private sessionInfo: SessionInfo | null = null;
  private initialized = false;
  private readonly indexWriter: IndexWriter;

  constructor(indexWriter?: IndexWriter, sessionId?: string) {
    this.indexWriter = indexWriter ?? new IndexWriter();
    this.sessionId = sessionId ?? generateSessionId();
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionDirectory(baseDirectory: string): string {
    return path.join(baseDirectory, this.sessionId);
  }

  ensureSessionDirectorySync(baseDirectory: string): string | null {
    try {
      const sessionDirectory = this.getSessionDirectory(baseDirectory);
      fs.mkdirSync(sessionDirectory, { recursive: true });
      return sessionDirectory;
    } catch {
      return null;
    }
  }

  async ensureSessionDirectory(baseDirectory: string): Promise<string | null> {
    try {
      const sessionDirectory = this.getSessionDirectory(baseDirectory);
      await fs.promises.mkdir(sessionDirectory, { recursive: true });
      return sessionDirectory;
    } catch {
      return null;
    }
  }

  async initializeSession(
    baseDirectory: string | null,
    info: Omit<SessionInfo, "sessionId">,
  ): Promise<void> {
    if (!baseDirectory || this.initialized) return;

    try {
      await fs.promises.mkdir(baseDirectory, { recursive: true });
      const sessionDirectory = await this.ensureSessionDirectory(baseDirectory);
      if (!sessionDirectory) return;

      const sessionInfo: SessionInfo = {
        sessionId: this.sessionId,
        ...info,
      };
      this.sessionInfo = sessionInfo;

      const sessionJsonPath = path.join(sessionDirectory, "session.json");
      await fs.promises.writeFile(
        sessionJsonPath,
        JSON.stringify(sessionInfo, null, 2),
        "utf8",
      );

      await this.indexWriter.append(
        path.join(baseDirectory, "sessions.jsonl"),
        {
          ...sessionInfo,
          path: `${this.sessionId}/`,
        },
      );

      this.initialized = true;
    } catch {
      // Silent failure - logging should never crash the extension
    }
  }

  getSessionInfo(): SessionInfo | null {
    return this.sessionInfo;
  }
}
