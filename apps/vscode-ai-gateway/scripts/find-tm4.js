const fs = require("fs");
const lines = fs
  .readFileSync("/tmp/tm4_lines.jsonl", "utf8")
  .trim()
  .split("\n");
console.log(`Checking ${lines.length} lines...`);

for (const line of lines) {
  try {
    const json = JSON.parse(line);
    const msgs = json.messages;
    if (!msgs || msgs.length === 0) continue;

    const lastMsg = msgs[msgs.length - 1];
    if (lastMsg.role !== "user") continue;

    let content = lastMsg.content;
    if (Array.isArray(content)) {
      content = content.map((p) => p.text || "").join("");
    }

    // precise match for "Test Message 4."
    if (
      content &&
      content.includes("Test Message 4") &&
      !content.includes("Test Message 5")
    ) {
      console.log(`Found candidate with timestamp: ${json.timestamp}`);
      fs.writeFileSync("/tmp/real_tm4.json", line); // overwrites, so last one wins (which is what we want, the latest attempt)
    }
  } catch (e) {
    // ignore
  }
}
