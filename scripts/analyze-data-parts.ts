/**
 * Analyze all data parts across forensic captures to understand what they are.
 * Reports: which messages have them, mimeType, size, and whether they persist.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

const MAX_CAPTURES = 10;

interface DataPartInfo {
  captureIndex: number;
  timestamp: string;
  messageIndex: number;
  messageRole: string;
  messageCount: number;
  partIndex: number;
  partType: string;
  mimeType?: string;
  dataSize?: number;
  partDigest?: string;
  // For context, what's in the text parts of this message
  textPreview?: string;
}

async function main() {
  const filePath = path.join(
    os.homedir(),
    ".vscode-ai-gateway",
    "forensic-captures.jsonl",
  );

  if (!fs.existsSync(filePath)) {
    console.error("No forensic captures file found");
    process.exit(1);
  }

  const lines: string[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.trim()) {
      lines.push(line);
      if (lines.length > MAX_CAPTURES * 3) {
        lines.splice(0, lines.length - MAX_CAPTURES * 3);
      }
    }
  }

  const captures = lines.slice(-MAX_CAPTURES);
  const allDataParts: DataPartInfo[] = [];

  for (let ci = 0; ci < captures.length; ci++) {
    try {
      const capture = JSON.parse(captures[ci]);
      const messages = capture.fullContent?.messages ?? capture.messages ?? [];
      const timestamp = capture.timestamp ?? "unknown";

      for (let mi = 0; mi < messages.length; mi++) {
        const msg = messages[mi];
        const content = msg.content ?? [];

        // Find text preview from text parts
        const textParts = content.filter((p: any) => p.type === "text");
        const textPreview =
          textParts.length > 0
            ? (textParts[0].text?.substring(0, 80) ?? "")
            : "";

        for (let pi = 0; pi < content.length; pi++) {
          const part = content[pi];
          if (part.type === "data") {
            allDataParts.push({
              captureIndex: ci,
              timestamp,
              messageIndex: mi,
              messageRole: msg.role,
              messageCount: messages.length,
              partIndex: pi,
              partType: part.type,
              mimeType: part.mimeType,
              dataSize: part.dataSize,
              partDigest: part.partDigest,
              textPreview,
            });
          }
        }
      }
    } catch (e) {
      console.error(`Failed to parse capture ${ci}: ${e}`);
    }
  }

  console.log(
    `Found ${allDataParts.length} data parts across ${captures.length} captures\n`,
  );

  // Group by digest to see which data parts are the same
  const byDigest = new Map<string, DataPartInfo[]>();
  for (const dp of allDataParts) {
    const key = dp.partDigest ?? "unknown";
    if (!byDigest.has(key)) byDigest.set(key, []);
    byDigest.get(key)!.push(dp);
  }

  console.log(`=== Unique Data Parts (by digest) ===\n`);
  for (const [digest, parts] of byDigest) {
    const first = parts[0];
    console.log(`Digest: ${digest}`);
    console.log(`  MimeType: ${first.mimeType ?? "unknown"}`);
    console.log(`  DataSize: ${first.dataSize ?? "unknown"}`);
    console.log(`  Appears in ${parts.length} capture(s)`);
    console.log(
      `  Message indices: ${[...new Set(parts.map((p) => p.messageIndex))].join(", ")}`,
    );
    console.log(
      `  Message roles: ${[...new Set(parts.map((p) => p.messageRole))].join(", ")}`,
    );
    console.log(`  Text preview: "${first.textPreview}"`);

    // Show which captures have it and which don't
    const captureSet = new Set(parts.map((p) => p.captureIndex));
    const missing = [];
    for (let i = 0; i < captures.length; i++) {
      if (!captureSet.has(i)) missing.push(i);
    }
    if (missing.length > 0) {
      console.log(`  MISSING from captures: ${missing.join(", ")}`);
    }
    console.log();
  }

  // Show per-capture summary
  console.log(`=== Per-Capture Summary ===\n`);
  for (let ci = 0; ci < captures.length; ci++) {
    const parts = allDataParts.filter((p) => p.captureIndex === ci);
    try {
      const capture = JSON.parse(captures[ci]);
      const msgCount = (capture.fullContent?.messages ?? capture.messages ?? [])
        .length;
      console.log(
        `Capture ${ci} (${capture.timestamp}): ${msgCount} messages, ${parts.length} data parts`,
      );
      if (parts.length > 0) {
        for (const p of parts) {
          console.log(
            `  msg[${p.messageIndex}] (${p.messageRole}): ${p.mimeType ?? "?"}, ${p.dataSize ?? "?"} bytes, digest=${p.partDigest}`,
          );
        }
      }
    } catch {
      /* skip */
    }
  }
}

main().catch(console.error);
