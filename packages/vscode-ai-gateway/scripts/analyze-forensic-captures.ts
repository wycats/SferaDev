#!/usr/bin/env node
/**
 * Analyze Forensic Captures
 *
 * Reads forensic-captures.jsonl and analyzes for conversation identifier patterns.
 *
 * Usage: node scripts/analyze-forensic-captures.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface ForensicCapture {
  sequence: number;
  timestamp: string;
  vscodeEnv: {
    sessionId: string;
    machineId: string;
    [key: string]: unknown;
  };
  model: { id: string; family: string };
  messages: {
    count: number;
    roles: string[];
    contentSummary: Array<{ hash: string; role: string }>;
  };
  systemPrompt?: { hash: string; length: number };
  options: { toolCount: number; toolNames: string[] };
  tokens: { estimated: number };
  internalState: {
    chatId: string;
    currentAgentId: string | null;
    hasActiveStreaming: boolean;
  };
}

function loadCaptures(): ForensicCapture[] {
  const filePath = path.join(
    os.homedir(),
    ".vscode-ai-gateway",
    "forensic-captures.jsonl",
  );

  if (!fs.existsSync(filePath)) {
    console.error("No captures found at:", filePath);
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  return lines.map((line) => JSON.parse(line) as ForensicCapture);
}

function groupBySystemPromptHash(
  captures: ForensicCapture[],
): Map<string, ForensicCapture[]> {
  const groups = new Map<string, ForensicCapture[]>();

  for (const capture of captures) {
    const hash = capture.systemPrompt?.hash ?? "no-system-prompt";
    const group = groups.get(hash) ?? [];
    group.push(capture);
    groups.set(hash, group);
  }

  return groups;
}

function analyzeGroup(hash: string, captures: ForensicCapture[]): void {
  console.log(`\n## System Prompt Hash: ${hash}`);
  console.log(`   Captures: ${captures.length.toString()}`);

  // Check if message counts vary (subagents typically have fewer messages)
  const messageCounts = captures.map((c) => c.messages.count);
  const minMessages = Math.min(...messageCounts);
  const maxMessages = Math.max(...messageCounts);
  console.log(
    `   Message counts: ${minMessages.toString()} - ${maxMessages.toString()}`,
  );

  // Check tool counts
  const toolCounts = new Set(captures.map((c) => c.options.toolCount));
  console.log(`   Tool counts: ${[...toolCounts].join(", ")}`);

  // Check if first message hash is consistent (conversation identity)
  const firstMessageHashes = new Set(
    captures.map((c) => c.messages.contentSummary[0]?.hash ?? "none"),
  );
  console.log(
    `   Unique first message hashes: ${firstMessageHashes.size.toString()}`,
  );

  // Show timeline
  console.log("   Timeline:");
  for (const capture of captures) {
    const time = new Date(capture.timestamp).toLocaleTimeString();
    const msgs = capture.messages.count;
    const tokens = capture.tokens.estimated;
    const isStreaming = capture.internalState.hasActiveStreaming
      ? " [STREAMING]"
      : "";
    console.log(
      `     ${time}: ${msgs.toString()} msgs, ${tokens.toString()} tokens${isStreaming}`,
    );
  }
}

function findDifferences(captures: ForensicCapture[]): void {
  if (captures.length < 2) return;

  console.log("\n## Field Differences Across Captures\n");

  // Compare all captures to find fields that vary
  const fields = [
    "vscodeEnv.sessionId",
    "vscodeEnv.machineId",
    "model.id",
    "model.family",
    "systemPrompt.hash",
    "messages.count",
    "options.toolCount",
    "internalState.chatId",
  ];

  console.log("| Field | Unique Values | Sample Values |");
  console.log("|-------|---------------|---------------|");

  for (const field of fields) {
    const values = captures.map((c) => {
      const parts = field.split(".");
      let val: unknown = c as unknown;
      for (const part of parts) {
        val = (val as Record<string, unknown>)?.[part];
      }
      return String(val ?? "undefined");
    });

    const unique = new Set(values);
    const samples = [...unique].slice(0, 3).join(", ");
    console.log(`| ${field} | ${unique.size.toString()} | ${samples} |`);
  }
}

function main(): void {
  console.log("# Forensic Capture Analysis\n");

  const captures = loadCaptures();
  console.log(`Loaded ${captures.length.toString()} captures\n`);

  // Group by system prompt hash
  const groups = groupBySystemPromptHash(captures);
  console.log(`Found ${groups.size.toString()} unique system prompt hashes`);

  // Analyze each group
  for (const [hash, group] of groups) {
    analyzeGroup(hash, group);
  }

  // Find differences
  findDifferences(captures);

  // Recommendations
  console.log("\n## Recommendations\n");
  console.log("Look for fields that:");
  console.log(
    "1. Stay constant within a conversation (same system prompt hash)",
  );
  console.log("2. Change between main agent and subagent");
  console.log("3. Could serve as unique conversation identifier");
}

main();
