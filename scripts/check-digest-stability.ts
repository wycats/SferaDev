/**
 * Compare normalized digests between last two captures to check
 * if the cache_control fix resolved hash drift after reload.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

async function main() {
  const filePath = path.join(
    os.homedir(),
    ".vscode-ai-gateway",
    "forensic-captures.jsonl",
  );

  const lines: string[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.trim()) lines.push(line);
  }

  // Get last two captures
  const last2 = lines.slice(-2);
  if (last2.length < 2) {
    console.log("Need at least 2 captures");
    process.exit(1);
  }

  const prev = JSON.parse(last2[0]);
  const curr = JSON.parse(last2[1]);

  const prevMsgs = prev.fullContent?.messages ?? prev.messages ?? [];
  const currMsgs = curr.fullContent?.messages ?? curr.messages ?? [];

  console.log(
    `Previous capture: ${prev.timestamp} (${prevMsgs.length} messages)`,
  );
  console.log(
    `Current capture:  ${curr.timestamp} (${currMsgs.length} messages)`,
  );

  // Count data parts in each
  let prevDataParts = 0,
    currDataParts = 0;
  for (const msg of prevMsgs) {
    for (const part of msg.content ?? []) {
      if (part.type === "data") prevDataParts++;
    }
  }
  for (const msg of currMsgs) {
    for (const part of msg.content ?? []) {
      if (part.type === "data") currDataParts++;
    }
  }
  console.log(`\nData parts: prev=${prevDataParts}, curr=${currDataParts}`);

  // Compare overlapping messages by normalizedDigest
  const overlap = Math.min(prevMsgs.length, currMsgs.length);
  let matches = 0;
  let mismatches = 0;
  const mismatchDetails: string[] = [];

  for (let i = 0; i < overlap; i++) {
    const pDigest = prevMsgs[i].normalizedDigest;
    const cDigest = currMsgs[i].normalizedDigest;

    if (pDigest === cDigest) {
      matches++;
    } else {
      mismatches++;
      const pRole = prevMsgs[i].role ?? "?";
      const cRole = currMsgs[i].role ?? "?";
      const pParts = (prevMsgs[i].content ?? []).length;
      const cParts = (currMsgs[i].content ?? []).length;
      const pText =
        (prevMsgs[i].content ?? [])
          .find((p: any) => p.type === "text")
          ?.text?.substring(0, 60) ?? "";

      mismatchDetails.push(
        `  msg[${i}] ${pRole}→${cRole}: parts ${pParts}→${cParts}\n` +
          `    prev: ${pDigest}\n` +
          `    curr: ${cDigest}\n` +
          `    text: "${pText}..."`,
      );
    }
  }

  console.log(`\nOverlapping messages: ${overlap}`);
  console.log(`Matches: ${matches}`);
  console.log(`Mismatches: ${mismatches}`);

  if (mismatches > 0) {
    console.log(`\n=== MISMATCHES ===`);
    for (const d of mismatchDetails) {
      console.log(d);
    }
  } else {
    console.log(`\n✅ ALL DIGESTS MATCH — hash drift is resolved!`);
  }
}

main().catch(console.error);
