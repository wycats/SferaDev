/**
 * Show the last N captures with timestamps and message counts,
 * plus first message text preview to identify conversation identity.
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

  const N = 15;
  const recent = lines.slice(-N);

  for (let i = 0; i < recent.length; i++) {
    const capture = JSON.parse(recent[i]);
    const msgs = capture.fullContent?.messages ?? capture.messages ?? [];
    const lastMsg = msgs[msgs.length - 1];
    const lastText =
      (lastMsg?.content ?? [])
        .find((p: any) => p.type === "text")
        ?.text?.substring(0, 80) ?? "";

    // Count data parts
    let dataParts = 0;
    for (const msg of msgs) {
      for (const part of msg.content ?? []) {
        if (part.type === "data") dataParts++;
      }
    }

    console.log(
      `[${i}] ${capture.timestamp} | ${msgs.length} msgs | ${dataParts} data parts | last: "${lastText}"`,
    );
  }
}

main().catch(console.error);
