/**
 * Dump the raw content of data parts to see exactly what they contain.
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
    if (line.trim()) {
      lines.push(line);
    }
  }

  // Use a capture that has data parts (capture index 3 from our analysis = 4th from end of last 10)
  // Let's use the most recent captures
  const recentCaptures = lines.slice(-10);

  for (let ci = 3; ci < Math.min(5, recentCaptures.length); ci++) {
    const capture = JSON.parse(recentCaptures[ci]);
    const messages = capture.fullContent?.messages ?? capture.messages ?? [];

    console.log(`\n=== Capture ${ci} (${capture.timestamp}) ===`);

    for (let mi = 0; mi < messages.length; mi++) {
      const msg = messages[mi];
      const content = msg.content ?? [];

      for (let pi = 0; pi < content.length; pi++) {
        const part = content[pi];
        if (part.type === "data") {
          console.log(`\nmsg[${mi}] (${msg.role}) part[${pi}]:`);
          console.log(
            `  Full part object keys: ${Object.keys(part).join(", ")}`,
          );
          console.log(`  mimeType: ${part.mimeType}`);
          console.log(`  dataSize: ${part.dataSize}`);

          // Try to show the actual data
          if (part.data) {
            console.log(`  data type: ${typeof part.data}`);
            if (typeof part.data === "string") {
              console.log(`  data value: "${part.data}"`);
            } else if (part.data instanceof Object) {
              console.log(`  data value: ${JSON.stringify(part.data)}`);
            }
          }
          if (part.rawData) {
            console.log(`  rawData: ${JSON.stringify(part.rawData)}`);
          }
          // Show everything
          console.log(`  FULL DUMP: ${JSON.stringify(part, null, 2)}`);
        }
      }
    }
  }
}

main().catch(console.error);
