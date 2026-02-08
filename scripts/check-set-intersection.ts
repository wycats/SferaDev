/**
 * Compare normalized digests between two captures by matching
 * messages on normalizedDigest (set intersection), not by index.
 * Also compare by rawDigest to isolate what changed.
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

  // Compare capture before burst (index 2, 41 msgs) with post-reload (index 14, 43 msgs)
  // Both should share messages from the same conversation
  const captures = lines.slice(-15);

  const preReload = JSON.parse(captures[2]); // 41 msgs, pre-build
  const postReload = JSON.parse(captures[14]); // 43 msgs, post-reload

  const preMsgs = preReload.fullContent?.messages ?? preReload.messages ?? [];
  const postMsgs =
    postReload.fullContent?.messages ?? postReload.messages ?? [];

  console.log(
    `Pre-reload:  ${preReload.timestamp} (${preMsgs.length} messages)`,
  );
  console.log(
    `Post-reload: ${postReload.timestamp} (${postMsgs.length} messages)`,
  );

  // Build set of normalizedDigests from pre-reload
  const preDigests = new Set<string>();
  const preDigestMap = new Map<
    string,
    { index: number; role: string; text: string }
  >();
  for (let i = 0; i < preMsgs.length; i++) {
    const d = preMsgs[i].normalizedDigest;
    preDigests.add(d);
    const text =
      (preMsgs[i].content ?? [])
        .find((p: any) => p.type === "text")
        ?.text?.substring(0, 60) ?? "";
    preDigestMap.set(d, { index: i, role: preMsgs[i].role, text });
  }

  // Check each post-reload message against pre-reload
  let found = 0;
  let notFound = 0;
  const newMsgs: string[] = [];

  for (let i = 0; i < postMsgs.length; i++) {
    const d = postMsgs[i].normalizedDigest;
    if (preDigests.has(d)) {
      found++;
    } else {
      notFound++;
      const text =
        (postMsgs[i].content ?? [])
          .find((p: any) => p.type === "text")
          ?.text?.substring(0, 80) ?? "";
      newMsgs.push(
        `  post[${i}] (${postMsgs[i].role}): digest=${d}\n    text: "${text}"`,
      );
    }
  }

  console.log(`\n=== Set Intersection ===`);
  console.log(
    `Post-reload messages found in pre-reload: ${found}/${postMsgs.length}`,
  );
  console.log(`New messages (not in pre-reload): ${notFound}`);

  if (newMsgs.length > 0 && newMsgs.length <= 10) {
    console.log(`\nNew messages:`);
    for (const m of newMsgs) console.log(m);
  }

  if (found === postMsgs.length - 2) {
    // -2 for the new test message + response
    console.log(
      `\n✅ PERFECT — all pre-reload messages hash identically post-reload!`,
    );
    console.log(
      `   (${notFound} new messages are the test message + response)`,
    );
  } else if (found >= postMsgs.length * 0.9) {
    console.log(
      `\n⚠️ CLOSE — ${((found / postMsgs.length) * 100).toFixed(1)}% match`,
    );
  } else {
    console.log(
      `\n❌ POOR — only ${((found / postMsgs.length) * 100).toFixed(1)}% match`,
    );
  }
}

main().catch(console.error);
