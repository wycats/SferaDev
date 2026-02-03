import * as fs from "node:fs";
import * as path from "node:path";
import { safeJsonStringify } from "../utils/serialize.js";
import type { LogEntry } from "./types";

export class IndexWriter {
  async append(
    filePath: string,
    entry: LogEntry | Record<string, unknown>,
  ): Promise<void> {
    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.appendFile(
        filePath,
        `${safeJsonStringify(entry)}\n`,
        "utf8",
      );
    } catch {
      // Silent failure - logging is best-effort
    }
  }
}
