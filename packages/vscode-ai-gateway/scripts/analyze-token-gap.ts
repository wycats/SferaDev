#!/usr/bin/env node
/**
 * Analyze token estimation gap between forensic captures and API actuals
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const forensicPath = path.join(
  os.homedir(),
  ".vscode-ai-gateway",
  "forensic-captures.jsonl",
);
const responsePath = path.join(
  os.homedir(),
  ".vscode-ai-gateway",
  "response-chain.jsonl",
);

interface ForensicEntry {
  sequence: number;
  timestamp: string;
  tokens: {
    estimated: number;
    maxInput: number;
    percentUsed: number;
    breakdown?: {
      messageTokens: number;
      toolTokens: number;
      systemPromptTokens: number;
    };
  };
  options: {
    toolCount: number;
    toolSchemaCharacterTotal?: number;
  };
  messages: {
    count: number;
  };
}

interface ResponseEntry {
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
}

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    return [];
  }
  const content = fs.readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((x): x is T => x !== null);
}

function findClosestResponse(
  forensicTs: string,
  responses: ResponseEntry[],
): ResponseEntry | null {
  const forensicTime = new Date(forensicTs).getTime();
  let closest: ResponseEntry | null = null;
  let minDiff = Infinity;

  for (const resp of responses) {
    const respTime = new Date(resp.timestamp).getTime();
    // Response should come AFTER forensic capture (within 60 seconds)
    const diff = respTime - forensicTime;
    if (diff > 0 && diff < 60000 && diff < minDiff) {
      minDiff = diff;
      closest = resp;
    }
  }
  return closest;
}

function main() {
  const forensic = readJsonl<ForensicEntry>(forensicPath).slice(-20);
  const responses = readJsonl<ResponseEntry>(responsePath);

  console.log("\n=== Token Gap Analysis ===\n");
  console.log(
    "Seq  | Est      | Actual   | Gap      | Gap%  | Tools | Msgs | Breakdown",
  );
  console.log(
    "-----|----------|----------|----------|-------|-------|------|----------",
  );

  for (const f of forensic) {
    const resp = findClosestResponse(f.timestamp, responses);
    if (!resp) continue;

    const gap = resp.inputTokens - f.tokens.estimated;
    const gapPct = Math.round((gap / resp.inputTokens) * 100);
    const breakdown = f.tokens.breakdown
      ? `msg=${f.tokens.breakdown.messageTokens}, tool=${f.tokens.breakdown.toolTokens}, sys=${f.tokens.breakdown.systemPromptTokens}`
      : "N/A";

    console.log(
      `${f.sequence.toString().padStart(4)} | ${f.tokens.estimated.toString().padStart(8)} | ${resp.inputTokens.toString().padStart(8)} | ${gap.toString().padStart(8)} | ${gapPct.toString().padStart(4)}% | ${f.options.toolCount.toString().padStart(5)} | ${f.messages.count.toString().padStart(4)} | ${breakdown}`,
    );
  }

  console.log("\n=== Summary ===");

  // Find entries with breakdown
  const withBreakdown = forensic.filter((f) => f.tokens.breakdown);
  if (withBreakdown.length > 0) {
    console.log("\nEntries with token breakdown:");
    for (const f of withBreakdown) {
      const resp = findClosestResponse(f.timestamp, responses);
      if (!resp) continue;

      const b = f.tokens.breakdown!;
      const total = b.messageTokens + b.toolTokens + b.systemPromptTokens;
      console.log(`  Seq ${f.sequence}:`);
      console.log(`    Message tokens:      ${b.messageTokens}`);
      console.log(`    Tool tokens:         ${b.toolTokens}`);
      console.log(`    System prompt tokens: ${b.systemPromptTokens}`);
      console.log(`    Sum:                 ${total}`);
      console.log(`    Estimated total:     ${f.tokens.estimated}`);
      console.log(`    Actual:              ${resp.inputTokens}`);
      console.log(
        `    Gap:                 ${resp.inputTokens - f.tokens.estimated}`,
      );
    }
  } else {
    console.log(
      "\nNo entries with breakdown found. Reload VS Code and make a request.",
    );
  }

  // Calculate what tool tokens SHOULD be
  const latestWithChars = forensic.find(
    (f) => f.options.toolSchemaCharacterTotal,
  );
  if (latestWithChars) {
    const chars = latestWithChars.options.toolSchemaCharacterTotal!;
    const expectedToolTokens = Math.ceil(chars / 4);
    console.log(`\n=== Tool Token Calculation ===`);
    console.log(`Tool schema chars: ${chars}`);
    console.log(`Expected tokens (chars/4): ${expectedToolTokens}`);
    console.log(`Tool count: ${latestWithChars.options.toolCount}`);
    console.log(
      `Tokens per tool: ${Math.round(expectedToolTokens / latestWithChars.options.toolCount)}`,
    );
  }
}

main();
