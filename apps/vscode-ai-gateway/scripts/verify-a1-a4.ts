import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type FullContentMessage = {
  role: string;
  name?: string;
  normalizedDigest?: string;
  rawDigest?: string;
  content: {
    type: string;
    toolName?: string;
    callId?: string;
    partDigest?: string;
  }[];
};

type Capture = {
  sequence: number;
  timestamp: string;
  fullContent?: {
    messages: FullContentMessage[];
  };
};

type Counter = {
  total: number;
  mismatches: number;
};

function loadCaptures(filePath: string): Capture[] {
  const text = fs.readFileSync(filePath, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Capture)
    .filter((capture) => Boolean(capture.fullContent));
}

function compareDigests(
  prev: FullContentMessage,
  curr: FullContentMessage,
  counter: Counter,
): void {
  counter.total += 1;
  if (prev.rawDigest !== curr.rawDigest || prev.role !== curr.role) {
    counter.mismatches += 1;
  }
}

function compareNormalizedStability(
  prev: FullContentMessage,
  curr: FullContentMessage,
  stats: { rawDiff: number; normalizedSame: number; normalizedDiff: number },
): void {
  if (!prev.rawDigest || !curr.rawDigest) {
    return;
  }
  if (prev.rawDigest === curr.rawDigest) {
    return;
  }
  stats.rawDiff += 1;
  if (prev.normalizedDigest === curr.normalizedDigest) {
    stats.normalizedSame += 1;
  } else {
    stats.normalizedDiff += 1;
  }
}

function compareCallIds(
  prev: FullContentMessage,
  curr: FullContentMessage,
  counter: Counter,
): void {
  const prevParts = prev.content.filter(
    (part) => part.type === "toolCall" || part.type === "toolResult",
  );
  const currParts = curr.content.filter(
    (part) => part.type === "toolCall" || part.type === "toolResult",
  );

  const length = Math.min(prevParts.length, currParts.length);
  for (let i = 0; i < length; i += 1) {
    const left = prevParts[i]!;
    const right = currParts[i]!;
    if (left.type !== right.type || left.toolName !== right.toolName) {
      counter.total += 1;
      counter.mismatches += 1;
      continue;
    }
    counter.total += 1;
    if (left.callId !== right.callId) {
      counter.mismatches += 1;
    }
  }
}

function main(): void {
  const capturePath =
    process.argv[2] ??
    path.join(os.homedir(), ".vscode-ai-gateway", "forensic-captures.jsonl");

  if (!fs.existsSync(capturePath)) {
    console.error(`Capture file not found: ${capturePath}`);
    process.exit(1);
  }

  const captures = loadCaptures(capturePath).sort(
    (a, b) => a.sequence - b.sequence,
  );

  if (captures.length < 2) {
    console.log("Not enough captures to compare.");
    return;
  }

  const a1: Counter = { total: 0, mismatches: 0 };
  const a2: Counter = { total: 0, mismatches: 0 };
  const a4: Counter = { total: 0, mismatches: 0 };
  const a3 = { rawDiff: 0, normalizedSame: 0, normalizedDiff: 0 };
  let lengthMismatches = 0;
  let expectedGrowth = 0;
  let unexpectedShrink = 0;

  for (let idx = 1; idx < captures.length; idx += 1) {
    const prev = captures[idx - 1]?.fullContent?.messages ?? [];
    const curr = captures[idx]?.fullContent?.messages ?? [];
    const length = Math.min(prev.length, curr.length);

    // Track length changes
    // Expected: curr.length = prev.length + 2 (our response + new user message)
    const expectedLen = prev.length + 2;
    if (curr.length !== expectedLen) {
      lengthMismatches += 1;
      if (curr.length < prev.length) {
        unexpectedShrink += 1; // Possible summarization
      } else if (curr.length !== expectedLen) {
        expectedGrowth += 1; // Unexpected growth pattern
      }
    }

    for (let i = 0; i < length; i += 1) {
      const prevMsg = prev[i]!;
      const currMsg = curr[i]!;

      if (prevMsg.role !== "Assistant" && currMsg.role !== "Assistant") {
        compareDigests(prevMsg, currMsg, a1);
      }

      if (prevMsg.role === "Assistant" && currMsg.role === "Assistant") {
        compareDigests(prevMsg, currMsg, a2);
      }

      compareNormalizedStability(prevMsg, currMsg, a3);
      compareCallIds(prevMsg, currMsg, a4);
    }
  }

  const percent = (count: number, total: number): string => {
    if (total === 0) {
      return "n/a";
    }
    return `${((count / total) * 100).toFixed(1)}%`;
  };

  console.log("A1 (non-Assistant messages preserved verbatim)");
  console.log(
    `  total: ${a1.total.toString()} mismatches: ${a1.mismatches.toString()} (${percent(
      a1.mismatches,
      a1.total,
    )})`,
  );

  console.log("A2 (Assistant messages round-trip unchanged)");
  console.log(
    `  total: ${a2.total.toString()} mismatches: ${a2.mismatches.toString()} (${percent(
      a2.mismatches,
      a2.total,
    )})`,
  );

  console.log("A3 (normalized digest stability)");
  console.log(
    `  raw-diff pairs: ${a3.rawDiff.toString()} normalized-same: ${a3.normalizedSame.toString()} normalized-diff: ${a3.normalizedDiff.toString()}`,
  );

  console.log("A4 (tool callId stability)");
  console.log(
    `  total: ${a4.total.toString()} mismatches: ${a4.mismatches.toString()} (${percent(
      a4.mismatches,
      a4.total,
    )})`,
  );

  console.log("\nLength analysis:");
  console.log(`  unexpected length changes: ${lengthMismatches.toString()}`);
  console.log(
    `  shrinks (possible summarization): ${unexpectedShrink.toString()}`,
  );
  console.log(`  unexpected growth patterns: ${expectedGrowth.toString()}`);
}

main();
