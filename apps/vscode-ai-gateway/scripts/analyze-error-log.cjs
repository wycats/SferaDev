/// @ts-check
const fs = require("fs");
const path = require("path");

const LOG_PATH = path.resolve(__dirname, "../../../.logs/api-errors.log");

function getLastEntry() {
  const logText = fs.readFileSync(LOG_PATH, "utf8");
  const lines = logText.split("\n").filter((l) => l.trim());
  if (!lines.length) return null;
  return JSON.parse(lines[lines.length - 1]);
}

function summarize() {
  const data = getLastEntry();
  if (!data) {
    console.log("No entries in log");
    return;
  }

  const req = data.request;
  console.log("Timestamp:", data.timestamp);
  console.log("Items:", req.input?.length || 0);
  console.log("Tools:", req.tools?.length || 0);
  console.log("Request size:", JSON.stringify(req).length, "bytes");

  const roles = {};
  const types = {};
  for (const item of req.input || []) {
    const roleKey = item.role || "undefined";
    roles[roleKey] = (roles[roleKey] || 0) + 1;
    types[item.type] = (types[item.type] || 0) + 1;
  }
  console.log("Roles:", roles);
  console.log("Types:", types);

  console.log("\nResponse:", JSON.stringify(data.response, null, 2));
}

function checkIssues() {
  const data = getLastEntry();
  if (!data) return;

  const req = data.request;
  const issues = [];

  for (let i = 0; i < req.input.length; i++) {
    const item = req.input[i];

    if (item.type === "message") {
      if (!item.role) issues.push(`input[${i}]: message missing role`);
      if (!item.content) issues.push(`input[${i}]: message missing content`);
      if (!["user", "assistant", "developer", "system"].includes(item.role)) {
        issues.push(`input[${i}]: invalid role '${item.role}'`);
      }

      if (Array.isArray(item.content)) {
        for (let j = 0; j < item.content.length; j++) {
          const part = item.content[j];
          if (!part.type) {
            issues.push(
              `input[${i}].content[${j}]: missing type, keys: ${Object.keys(part)}`,
            );
          }
        }
      }
    }

    if (item.type === "function_call") {
      if (!item.call_id)
        issues.push(`input[${i}]: function_call missing call_id`);
      if (!item.name) issues.push(`input[${i}]: function_call missing name`);
      if (item.arguments === undefined)
        issues.push(`input[${i}]: function_call missing arguments`);
    }

    if (item.type === "function_call_output") {
      if (!item.call_id)
        issues.push(`input[${i}]: function_call_output missing call_id`);
      if (item.output === undefined)
        issues.push(`input[${i}]: function_call_output missing output`);
    }
  }

  console.log("Issues found:", issues.length);
  issues.forEach((i) => console.log(i));
}

function samples() {
  const data = getLastEntry();
  if (!data) return;

  const input = data.request.input;
  const byType = {};

  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    const key = item.type + (item.role ? "/" + item.role : "");
    if (!byType[key]) byType[key] = [];
    if (byType[key].length < 2) {
      byType[key].push({
        index: i,
        sample: JSON.stringify(item).substring(0, 300),
      });
    }
  }

  for (const [key, samples] of Object.entries(byType)) {
    console.log(`\n=== ${key} ===`);
    for (const s of samples) {
      console.log(`  [${s.index}]: ${s.sample}...`);
    }
  }
}

function dumpItem(index) {
  const data = getLastEntry();
  if (!data) return;

  const item = data.request.input[index];
  console.log(JSON.stringify(item, null, 2));
}

// CLI
const cmd = process.argv[2] || "summarize";
const arg = process.argv[3];

switch (cmd) {
  case "summarize":
    summarize();
    break;
  case "check":
    checkIssues();
    break;
  case "samples":
    samples();
    break;
  case "item":
    dumpItem(parseInt(arg, 10));
    break;
  case "roleDebug":
    roleDebug();
    break;
  case "props":
    showProps();
    break;
  default:
    console.log(
      "Usage: node analyze-error-log.cjs [summarize|check|samples|item <index>|roleDebug|props]",
    );
}

function showProps() {
  const data = getLastEntry();
  if (!data) return;

  const req = data.request;
  console.log("Model:", req.model);
  console.log("Stream:", req.stream);
  console.log("Temperature:", req.temperature);
  console.log("Max output tokens:", req.max_output_tokens);
  console.log("Instructions length:", req.instructions?.length || 0);
  console.log("Tool choice:", req.tool_choice);
  console.log("Has instructions:", !!req.instructions);

  const known = [
    "model",
    "input",
    "stream",
    "temperature",
    "max_output_tokens",
    "instructions",
    "tools",
    "tool_choice",
  ];
  const extra = Object.keys(req).filter((k) => !known.includes(k));
  console.log("Extra properties:", extra);
}

function roleDebug() {
  const data = getLastEntry();
  if (!data) return;

  const req = data.request;
  // We can't see the original VS Code roles, but we can look at the translated output
  // Check if there's any pattern in what became developer vs user/assistant

  const byRole = {};
  for (let i = 0; i < req.input.length; i++) {
    const item = req.input[i];
    if (item.type === "message") {
      if (!byRole[item.role]) byRole[item.role] = [];
      byRole[item.role].push({
        index: i,
        contentTypes: Array.isArray(item.content)
          ? item.content.map((c) => c.type).join(",")
          : typeof item.content,
      });
    }
  }

  for (const [role, items] of Object.entries(byRole)) {
    console.log(`\n=== ${role} (${items.length} messages) ===`);
    for (const item of items.slice(0, 3)) {
      console.log(`  [${item.index}]: ${item.contentTypes}`);
    }
    if (items.length > 3) console.log(`  ... and ${items.length - 3} more`);
  }
}
