#!/usr/bin/env node
/**
 * Forensic Capture Analysis Tool
 *
 * Analyzes what Copilot sends to our Language Model Provider.
 * Focus: Message structure, persistence surfaces, digest correlation.
 *
 * Usage: npx tsx scripts/analyze-forensic-captures.ts [command]
 *
 * Commands:
 *   summary       - Overview of captures (default)
 *   last [n]      - Full content of last n captures (default 1)
 *   timeline      - Message count progression across captures
 *   summarization - Detect conversation-summary tags
 *   raw [n]       - Raw JSON of last n captures
 *   messages      - Detailed message structure analysis
 *   keys          - All unique keys found on messages
 *   clear         - Clear the capture file
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CAPTURE_FILE = path.join(
  os.homedir(),
  ".vscode-ai-gateway",
  "forensic-captures.jsonl",
);

// Flexible interface - we want to discover what's there, not assume
interface ForensicCapture {
  sequence: number;
  timestamp: string;
  [key: string]: unknown;
}

function loadCaptures(limit?: number): ForensicCapture[] {
  if (!fs.existsSync(CAPTURE_FILE)) {
    console.error("No captures found at:", CAPTURE_FILE);
    console.error("Send a message in Copilot chat first.");
    process.exit(1);
  }

  const content = fs.readFileSync(CAPTURE_FILE, "utf-8");
  if (!content.trim()) {
    console.error("Capture file is empty.");
    console.error("Send a message in Copilot chat first.");
    process.exit(1);
  }

  let lines = content.trim().split("\n").filter(Boolean);
  if (limit) {
    lines = lines.slice(-limit);
  }

  return lines.map((line) => JSON.parse(line) as ForensicCapture);
}

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let val: unknown = obj;
  for (const part of parts) {
    if (val == null) return undefined;
    val = (val as Record<string, unknown>)[part];
  }
  return val;
}

function collectAllKeys(obj: unknown, prefix = ""): string[] {
  if (obj == null || typeof obj !== "object") return [];

  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    keys.push(fullKey);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      keys.push(...collectAllKeys(value, fullKey));
    }
  }
  return keys;
}

// Commands

function cmdSummary(): void {
  const captures = loadCaptures();
  console.log("# Q5 Forensic Capture Summary\n");
  console.log(`Captures: ${captures.length}`);
  console.log(`File: ${CAPTURE_FILE}`);

  if (captures.length === 0) return;

  const first = captures[0];
  const last = captures[captures.length - 1];
  console.log(`Time range: ${first.timestamp} → ${last.timestamp}`);

  console.log("\n## Most Recent Capture\n");
  const recent = last;

  // Top-level keys
  console.log("Top-level keys:", Object.keys(recent).join(", "));

  // Message info
  const messages = recent.messages as
    | { count?: number; roles?: string[] }
    | undefined;
  if (messages) {
    console.log(
      `\nMessages: ${messages.count ?? "?"} (roles: ${messages.roles?.join(", ") ?? "?"})`,
    );
  }

  // Raw message keys (THE KEY INFO for Q3)
  const rawAllMessages = recent.rawAllMessages as
    | Array<{ allKeys?: string[]; extraProps?: Record<string, unknown> }>
    | undefined;
  if (rawAllMessages) {
    console.log("\n### Raw Message Keys (Q3: undocumented properties)\n");
    for (let i = 0; i < rawAllMessages.length; i++) {
      const msg = rawAllMessages[i];
      console.log(`  [${i}] keys: [${msg.allKeys?.join(", ") ?? "?"}]`);
      if (msg.extraProps) {
        const extras = Object.entries(msg.extraProps)
          .filter(([, v]) => v !== "[unserializable: undefined]")
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
        if (extras.length > 0) {
          console.log(`       extras: ${extras.join(", ")}`);
        }
      }
    }
  }

  // Options
  const rawOptions = recent.rawOptions as
    | { allKeys?: string[]; fullDump?: unknown }
    | undefined;
  if (rawOptions) {
    console.log("\n### Options Keys\n");
    console.log(`  Keys: [${rawOptions.allKeys?.join(", ") ?? "?"}]`);
  }
}

function cmdRaw(count: number): void {
  const captures = loadCaptures(count);
  console.log(JSON.stringify(captures, null, 2));
}

function cmdMessages(): void {
  const captures = loadCaptures();
  console.log("# Message Structure Analysis\n");

  for (const capture of captures) {
    console.log(`\n## Capture ${capture.sequence} (${capture.timestamp})\n`);

    const rawAllMessages = capture.rawAllMessages as
      | Array<{
          index?: number;
          allKeys?: string[];
          role?: number;
          contentLength?: number;
          extraProps?: Record<string, unknown>;
        }>
      | undefined;

    if (!rawAllMessages) {
      console.log("No rawAllMessages found");
      continue;
    }

    for (const msg of rawAllMessages) {
      const roleNum = msg.role;
      const roleName =
        roleNum === 1
          ? "User"
          : roleNum === 2
            ? "Assistant"
            : roleNum === 3
              ? "System"
              : `Unknown(${roleNum})`;

      console.log(`### Message ${msg.index} (${roleName})`);
      console.log(`  Keys: [${msg.allKeys?.join(", ") ?? "none"}]`);
      console.log(`  Content length: ${msg.contentLength ?? "?"}`);

      // Q2: Does 'name' exist and persist?
      if (msg.allKeys?.includes("name")) {
        const nameVal = msg.extraProps?.name;
        console.log(
          `  ⭐ 'name' key present! Value: ${JSON.stringify(nameVal)}`,
        );
      }

      // Any other extra props?
      if (msg.extraProps) {
        const interesting = Object.entries(msg.extraProps).filter(
          ([k, v]) => k !== "name" && v !== "[unserializable: undefined]",
        );
        if (interesting.length > 0) {
          console.log(
            `  Extra props: ${JSON.stringify(Object.fromEntries(interesting))}`,
          );
        }
      }
    }
  }
}

function cmdKeys(): void {
  const captures = loadCaptures();
  console.log("# All Unique Keys Found\n");

  const allMessageKeys = new Set<string>();
  const allTopLevelKeys = new Set<string>();

  for (const capture of captures) {
    // Top-level
    for (const key of Object.keys(capture)) {
      allTopLevelKeys.add(key);
    }

    // Message keys
    const rawAllMessages = capture.rawAllMessages as
      | Array<{ allKeys?: string[] }>
      | undefined;
    if (rawAllMessages) {
      for (const msg of rawAllMessages) {
        for (const key of msg.allKeys ?? []) {
          allMessageKeys.add(key);
        }
      }
    }
  }

  console.log("## Top-level capture keys\n");
  console.log([...allTopLevelKeys].sort().join(", "));

  console.log("\n## Message keys (from rawAllMessages)\n");
  console.log([...allMessageKeys].sort().join(", "));
}

function cmdContent(): void {
  const captures = loadCaptures();
  console.log("# Full Message Content\n");

  for (const capture of captures) {
    console.log(`\n## Capture ${capture.sequence}\n`);

    const fullContent = (
      capture.messages as {
        fullContent?: Array<{ index: number; role: string; text: string }>;
      }
    )?.fullContent;

    if (!fullContent) {
      console.log(
        "No fullContent captured. Enable with: vercel.ai.debug.forensicCaptureFullContent: true",
      );
      continue;
    }

    for (const msg of fullContent) {
      console.log(`### [${msg.index}] ${msg.role}\n`);
      // Truncate long content
      const text =
        msg.text.length > 2000
          ? msg.text.slice(0, 2000) + "\n... (truncated)"
          : msg.text;
      console.log(text);
      console.log();
    }
  }
}

function cmdClear(): void {
  fs.writeFileSync(CAPTURE_FILE, "");
  console.log("Cleared:", CAPTURE_FILE);
}

function cmdLast(count: number): void {
  const captures = loadCaptures(count);
  console.log(`# Last ${count} Capture(s) with Full Content\n`);

  for (const capture of captures) {
    console.log(`## Capture ${capture.sequence} (${capture.timestamp})\n`);

    const fullContent = capture.fullContent as
      | {
          messages?: Array<{
            role: string;
            content: Array<{ type: string; text?: string }>;
          }>;
        }
      | undefined;

    if (!fullContent?.messages) {
      console.log(
        "No fullContent. Enable: vercel.ai.debug.forensicCaptureFullContent: true\n",
      );
      continue;
    }

    console.log(`Messages: ${fullContent.messages.length}\n`);

    for (let i = 0; i < fullContent.messages.length; i++) {
      const msg = fullContent.messages[i];
      const textPart = msg.content.find((p) => p.type === "text");
      const text = textPart?.text ?? "(no text)";
      const preview = text.length > 200 ? text.slice(0, 200) + "..." : text;
      console.log(`[${i}] ${msg.role}: ${preview.replace(/\n/g, "\\n")}`);
    }
    console.log();
  }
}

function cmdTimeline(): void {
  const captures = loadCaptures();
  console.log("# Message Count Timeline\n");
  console.log("Seq\tMsgs\tDelta\tHasFull\tTimestamp");
  console.log("---\t----\t-----\t-------\t---------");

  let prevCount: number | null = null;

  for (const capture of captures) {
    const fullContent = capture.fullContent as
      | { messages?: unknown[] }
      | undefined;
    const messages = capture.messages as { count?: number } | undefined;

    const msgCount = fullContent?.messages?.length ?? messages?.count ?? 0;
    const hasFull = fullContent?.messages ? "✓" : "";
    const delta = prevCount !== null ? msgCount - prevCount : 0;
    const deltaStr = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : "";

    // Highlight drops (new conversation or summarization)
    const marker = delta < 0 ? " ← DROP" : "";

    console.log(
      `${capture.sequence}\t${msgCount}\t${deltaStr}\t${hasFull}\t${capture.timestamp}${marker}`,
    );
    prevCount = msgCount;
  }
}

function cmdSummarization(): void {
  const captures = loadCaptures();
  console.log("# Summarization Detection\n");

  const summaryPattern = /<conversation-summary>/i;

  for (const capture of captures) {
    const fullContent = capture.fullContent as
      | {
          messages?: Array<{
            role: string;
            content: Array<{ type: string; text?: string }>;
          }>;
        }
      | undefined;

    if (!fullContent?.messages) continue;

    for (let i = 0; i < fullContent.messages.length; i++) {
      const msg = fullContent.messages[i];
      for (const part of msg.content) {
        if (
          part.type === "text" &&
          part.text &&
          summaryPattern.test(part.text)
        ) {
          console.log(`## Capture ${capture.sequence}\n`);
          console.log(
            `Found <conversation-summary> at message index ${i} (${msg.role})`,
          );
          console.log(`Total messages: ${fullContent.messages.length}`);

          // Extract summary preview
          const start = part.text.indexOf("<conversation-summary>");
          const preview = part.text
            .slice(start, start + 500)
            .replace(/\n/g, "\\n");
          console.log(`\nPreview:\n${preview}...\n`);
          break;
        }
      }
    }
  }
}

// Main
const [, , command = "summary", ...args] = process.argv;

switch (command) {
  case "summary":
    cmdSummary();
    break;
  case "last":
    cmdLast(parseInt(args[0] ?? "1", 10));
    break;
  case "timeline":
    cmdTimeline();
    break;
  case "summarization":
    cmdSummarization();
    break;
  case "raw":
    cmdRaw(parseInt(args[0] ?? "1", 10));
    break;
  case "messages":
    cmdMessages();
    break;
  case "keys":
    cmdKeys();
    break;
  case "clear":
    cmdClear();
    break;
  default:
    console.log(`Unknown command: ${command}`);
    console.log(
      "Commands: summary, last, timeline, summarization, raw, messages, keys, clear",
    );
    process.exit(1);
}
