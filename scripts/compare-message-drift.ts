/**
 * Compare message content at a specific index across the last N forensic captures
 * to determine if VS Code is actually mutating the transcript.
 *
 * Usage: node scripts/compare-message-drift.ts [messageIndex]
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

const TARGET_INDEX = parseInt(process.argv[2] ?? "34", 10);
const MAX_CAPTURES = 5; // Only look at last N captures

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

  // Read last N lines (captures are appended)
  const lines: string[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.trim()) {
      lines.push(line);
      // Keep only last MAX_CAPTURES * 2 lines (in case there are many)
      if (lines.length > MAX_CAPTURES * 3) {
        lines.splice(0, lines.length - MAX_CAPTURES * 3);
      }
    }
  }

  console.log(`Total lines in file: processing last ${lines.length} captures`);
  console.log(`Looking at message index: ${TARGET_INDEX}\n`);

  const captures = lines.slice(-MAX_CAPTURES);

  for (let i = 0; i < captures.length; i++) {
    try {
      const capture = JSON.parse(captures[i]);
      const messages = capture.fullContent?.messages ?? capture.messages ?? [];
      const timestamp = capture.timestamp ?? "unknown";
      const messageCount = messages.length;

      console.log(
        `=== Capture ${i + 1} (${timestamp}) — ${messageCount} messages ===`,
      );

      if (TARGET_INDEX >= messageCount) {
        console.log(
          `  Index ${TARGET_INDEX} out of range (only ${messageCount} messages)`,
        );
        console.log();
        continue;
      }

      const msg = messages[TARGET_INDEX];
      console.log(`  Role: ${msg.role}`);
      console.log(`  Normalized Digest: ${msg.normalizedDigest}`);
      console.log(`  Raw Digest: ${msg.rawDigest}`);
      console.log(`  Content Parts: ${msg.content?.length ?? 0}`);

      for (let j = 0; j < (msg.content?.length ?? 0); j++) {
        const part = msg.content[j];
        console.log(`  Part[${j}]:`);
        console.log(`    Type: ${part.type}`);
        console.log(`    Part Digest: ${part.partDigest ?? "n/a"}`);
        if (part.text) {
          // Show first 200 chars and last 100 chars
          const text = part.text;
          if (text.length > 350) {
            console.log(
              `    Text (${text.length} chars): "${text.substring(0, 200)}...<<<TRUNCATED>>>...${text.substring(text.length - 100)}"`,
            );
          } else {
            console.log(`    Text (${text.length} chars): "${text}"`);
          }
        }
        if (part.callId) {
          console.log(`    CallId: ${part.callId}`);
        }
        if (part.toolName) {
          console.log(`    ToolName: ${part.toolName}`);
        }
        if (part.toolResult !== undefined) {
          const s = JSON.stringify(part.toolResult);
          console.log(
            `    ToolResult (${s.length} chars): ${s.substring(0, 200)}`,
          );
        }
      }

      console.log();
    } catch (e) {
      console.log(`  Failed to parse capture ${i + 1}: ${e}`);
    }
  }
}

main().catch(console.error);
