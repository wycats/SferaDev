/**
 * Error Log Export
 *
 * Creates a zip archive of the error logs directory for sharing with support.
 * Uses Node.js built-in zlib for compression.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

import { logger } from "../logger.js";

/**
 * Create a simple tar.gz archive of the errors directory.
 *
 * Uses a minimal tar implementation (512-byte headers + file data)
 * to avoid external dependencies. The archive can be extracted with
 * standard `tar xzf` on any platform.
 */
export async function createErrorLogsArchive(
  errorsDir: string,
): Promise<Buffer> {
  const files = await collectFiles(errorsDir, errorsDir);

  if (files.length === 0) {
    throw new ErrorExportEmpty();
  }

  logger.info(
    `[ErrorExport] Archiving ${files.length} files from ${errorsDir}`,
  );

  // Build tar stream
  const chunks: Buffer[] = [];

  for (const file of files) {
    const content = await fs.promises.readFile(file.absolutePath);
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
  return new Promise<Buffer>((resolve, reject) => {
    zlib.gzip(tarBuffer, (err, compressed) => {
      if (err) {
        reject(err);
      } else {
        resolve(compressed);
      }
    });
  });
}

export class ErrorExportEmpty extends Error {
  constructor() {
    super("No error logs to export");
    this.name = "ErrorExportEmpty";
  }
}

interface FileEntry {
  absolutePath: string;
  relativePath: string;
}

async function collectFiles(
  dir: string,
  rootDir: string,
): Promise<FileEntry[]> {
  const files: FileEntry[] = [];

  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        const subFiles = await collectFiles(absolutePath, rootDir);
        files.push(...subFiles);
      } else if (entry.isFile()) {
        files.push({
          absolutePath,
          relativePath: path.relative(rootDir, absolutePath),
        });
      }
    }
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      // Directory doesn't exist -- return empty
      return [];
    }
    throw err;
  }

  return files;
}

/**
 * Create a POSIX tar header (512 bytes) for a file entry.
 */
function createTarHeader(fileName: string, fileSize: number): Buffer {
  const header = Buffer.alloc(512);

  // Name (0-99, 100 bytes)
  header.write(fileName.slice(0, 100), 0, 100, "utf8");

  // Mode (100-107, 8 bytes) -- 0644
  header.write("0000644\0", 100, 8, "utf8");

  // UID (108-115, 8 bytes)
  header.write("0000000\0", 108, 8, "utf8");

  // GID (116-123, 8 bytes)
  header.write("0000000\0", 116, 8, "utf8");

  // Size (124-135, 12 bytes) -- octal
  header.write(fileSize.toString(8).padStart(11, "0") + "\0", 124, 12, "utf8");

  // Mtime (136-147, 12 bytes) -- current time in octal
  const mtime = Math.floor(Date.now() / 1000);
  header.write(mtime.toString(8).padStart(11, "0") + "\0", 136, 12, "utf8");

  // Checksum placeholder (148-155, 8 bytes) -- spaces for calculation
  header.write("        ", 148, 8, "utf8");

  // Type flag (156, 1 byte) -- '0' for regular file
  header.write("0", 156, 1, "utf8");

  // Calculate checksum (sum of all bytes in header, treating checksum field as spaces)
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    const byte = header[i] ?? 0;
    checksum += byte;
  }
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf8");

  return header;
}
