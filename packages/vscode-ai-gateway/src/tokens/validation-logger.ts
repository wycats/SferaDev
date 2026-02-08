import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { ConfigService } from "../config";

export interface TokenValidationLogEntry {
  type: "estimate" | "actual" | "deduction" | "cache-hit" | "cache-miss";
  modelFamily: string;

  // Counts
  totalTokens?: number;
  knownTokens?: number;
  estimatedTokens?: number;
  delta?: number;

  // Context
  messageCount?: number;
  newMessageCount?: number;

  // Deduction specifics
  deducedTokens?: number;
  messageRole?: string;
  messageDigest?: string;
  isProportional?: boolean; // true if tokens were distributed proportionally across multiple messages
}

export class TokenValidationLogger {
  private logPath: string | undefined;
  private logDir: string | undefined;

  constructor(private configService: ConfigService) {
    this.updateLogPath();
    configService.onDidChange(() => this.updateLogPath());
  }

  private updateLogPath() {
    const dir = this.configService.logFileDirectory;
    if (dir && typeof dir === "string" && dir.length > 0) {
      // Resolve relative paths against workspace root if available
      const workspaceFolder =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const absoluteDir =
        workspaceFolder && !path.isAbsolute(dir)
          ? path.join(workspaceFolder, dir)
          : dir;

      try {
        fs.mkdirSync(absoluteDir, { recursive: true });
        this.logDir = absoluteDir;
        this.logPath = path.join(absoluteDir, "token-validation.jsonl");
      } catch (e) {
        console.error("Failed to create token validation log directory", e);
        this.logDir = undefined;
        this.logPath = undefined;
      }
    } else {
      this.logDir = undefined;
      this.logPath = undefined;
    }
  }

  log(entry: Omit<TokenValidationLogEntry, "timestamp">) {
    if (!this.logPath) return;

    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry,
    });

    try {
      fs.appendFileSync(this.logPath, line + "\n");
    } catch (e) {
      // Fail silently to avoid interrupting the extension
    }
  }

  captureForensic(filename: string, data: unknown) {
    if (!this.logDir) {
      // Attempt to fallback to workspace root/.logs if config is missing but workspace exists
      const workspaceFolder =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspaceFolder) {
        const fallbackDir = path.join(workspaceFolder, ".logs");
        try {
          fs.mkdirSync(fallbackDir, { recursive: true });
          const filePath = path.join(fallbackDir, filename);
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
          return;
        } catch {}
      }
      return;
    }

    const filePath = path.join(this.logDir, filename);
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error(`Failed to write forensic capture to ${filePath}`, e);
    }
  }
}
