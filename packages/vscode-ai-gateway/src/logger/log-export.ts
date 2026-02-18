/**
 * Log Export for Bug Reports
 *
 * Creates a comprehensive archive containing:
 * - Error logs (always captured on failures)
 * - Investigation logs (if file logging was enabled)
 * - Extension metadata (version, settings snapshot)
 *
 * This is the primary way users share diagnostic data for bug reports.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as vscode from "vscode";

import { logger } from "../logger.js";

export interface LogExportResult {
  archive: Buffer;
  stats: {
    errorLogFiles: number;
    investigationLogFiles: number;
    totalSizeBytes: number;
  };
}

export class LogExportEmpty extends Error {
  constructor() {
    super("No logs to export");
    this.name = "LogExportEmpty";
  }
}

/**
 * Create a comprehensive log archive for bug reports.
 *
 * Includes:
 * - errors/ directory (always-on error capture)
 * - .logs/{investigation}/ directory (if file logging enabled)
 * - metadata.json (extension version, settings snapshot)
 */
export async function createLogArchive(
  globalStorageUri: vscode.Uri,
  workspaceRoot: string | null,
  investigationName: string,
): Promise<LogExportResult> {
  const files: FileEntry[] = [];
  let errorLogFiles = 0;
  let investigationLogFiles = 0;

  // Collect error logs
  const errorsDir = path.join(globalStorageUri.fsPath, "errors");
  if (fs.existsSync(errorsDir)) {
    const errorFiles = await collectFiles(errorsDir, errorsDir, "errors");
    files.push(...errorFiles);
    errorLogFiles = errorFiles.length;
  }

  // Collect investigation logs (if workspace and logs exist)
  if (workspaceRoot) {
    const investigationDir = path.join(
      workspaceRoot,
      ".logs",
      investigationName,
    );
    if (fs.existsSync(investigationDir)) {
      const invFiles = await collectFiles(
        investigationDir,
        investigationDir,
        `investigation/${investigationName}`,
      );
      files.push(...invFiles);
      investigationLogFiles = invFiles.length;
    }
  }

  if (files.length === 0) {
    throw new LogExportEmpty();
  }

  // Add metadata
  const metadata = createMetadata(investigationName);
  files.push({
    absolutePath: "",
    relativePath: "metadata.json",
    content: Buffer.from(JSON.stringify(metadata, null, 2)),
  });

  logger.info(
    `[LogExport] Archiving ${files.length} files (${errorLogFiles} error, ${investigationLogFiles} investigation)`,
  );

  // Build tar stream
  const chunks: Buffer[] = [];
  let totalSize = 0;

  for (const file of files) {
    const content =
      file.content ?? (await fs.promises.readFile(file.absolutePath));
    totalSize += content.length;

    const header = createTarHeader(file.relativePath, content.length);
    chunks.push(header);
    chunks.push(content);

    // Tar requires 512-byte alignment
    const padding = 512 - (content.length % 512);
    if (padding < 512) {
      chunks.push(Buffer.alloc(padding));
    }
  }

  // End-of-archive marker (two 512-byte zero blocks)
  chunks.push(Buffer.alloc(1024));

  const tarBuffer = Buffer.concat(chunks);

  // Gzip compress
  const archive = await new Promise<Buffer>((resolve, reject) => {
    zlib.gzip(tarBuffer, (err, compressed) => {
      if (err) {
        reject(err);
      } else {
        resolve(compressed);
      }
    });
  });

  return {
    archive,
    stats: {
      errorLogFiles,
      investigationLogFiles,
      totalSizeBytes: totalSize,
    },
  };
}

interface FileEntry {
  absolutePath: string;
  relativePath: string;
  content?: Buffer;
}

async function collectFiles(
  dir: string,
  rootDir: string,
  prefix: string,
): Promise<FileEntry[]> {
  const files: FileEntry[] = [];

  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        const subFiles = await collectFiles(absolutePath, rootDir, prefix);
        files.push(...subFiles);
      } else if (entry.isFile()) {
        files.push({
          absolutePath,
          relativePath: path.join(prefix, path.relative(rootDir, absolutePath)),
        });
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  return files;
}

function createMetadata(investigationName: string): Record<string, unknown> {
  const config = vscode.workspace.getConfiguration("vercel.ai");

  return {
    exportedAt: new Date().toISOString(),
    extension: {
      id: "vercel.vscode-ai-gateway",
      // Version will be filled in by the caller if available
    },
    settings: {
      endpoint: config.get("endpoint"),
      "logging.level": config.get("logging.level"),
      "logging.fileLevel": config.get("logging.fileLevel"),
      "logging.categories": config.get("logging.categories"),
      "logging.name": investigationName,
      "logging.granularity": config.get("logging.granularity"),
    },
    workspace: {
      folderCount: vscode.workspace.workspaceFolders?.length ?? 0,
    },
  };
}

/**
 * Create a POSIX ustar tar header for a file.
 */
function createTarHeader(filename: string, size: number): Buffer {
  const header = Buffer.alloc(512);

  // Filename (100 bytes)
  header.write(filename.slice(0, 100), 0, 100, "utf8");

  // File mode (8 bytes) - 0644
  header.write("0000644\0", 100, 8, "utf8");

  // UID (8 bytes)
  header.write("0000000\0", 108, 8, "utf8");

  // GID (8 bytes)
  header.write("0000000\0", 116, 8, "utf8");

  // Size (12 bytes) - octal
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "utf8");

  // Mtime (12 bytes) - current time in octal
  const mtime = Math.floor(Date.now() / 1000);
  header.write(mtime.toString(8).padStart(11, "0") + "\0", 136, 12, "utf8");

  // Checksum placeholder (8 bytes of spaces)
  header.write("        ", 148, 8, "utf8");

  // Type flag (1 byte) - '0' for regular file
  header.write("0", 156, 1, "utf8");

  // Link name (100 bytes) - empty
  // Already zeroed

  // Magic (6 bytes) - "ustar\0"
  header.write("ustar\0", 257, 6, "utf8");

  // Version (2 bytes) - "00"
  header.write("00", 263, 2, "utf8");

  // Calculate and write checksum
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i]!;
  }
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf8");

  return header;
}
