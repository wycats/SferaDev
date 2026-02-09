import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getEncoding } from "js-tiktoken";

type ToolLike = {
  name?: string;
  description?: string;
  inputSchema?: unknown;
  parameters?: unknown;
  function?: { name?: string; description?: string; parameters?: unknown };
};

type ToolInfo = {
  name: string;
  description: string;
  parameters: unknown;
};

type Options = {
  toolsPath?: string;
  logPath?: string;
  encodingName: string;
};

const DEFAULT_LOG_PATH = path.join(
  os.homedir(),
  ".vscode-ai-gateway",
  "token-count-calls.jsonl",
);

function parseArgs(argv: string[]): Options {
  const options: Options = {
    encodingName: "cl100k_base",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tools" && argv[i + 1]) {
      options.toolsPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--log" && argv[i + 1]) {
      options.logPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--encoding" && argv[i + 1]) {
      options.encodingName = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }
  return options;
}

function printUsage(): void {
  const script = "node scripts/analyze-tool-schema-overcount.ts";
  console.log("\nTool schema overcount analysis\n");
  console.log("Usage:");
  console.log(
    `  ${script} --tools /path/to/tools.json [--log /path/to/token-count-calls.jsonl]`,
  );
  console.log("\nOptions:");
  console.log(
    "  --tools     Path to JSON containing tools or a tool schema array",
  );
  console.log(
    `  --log       Path to token-count-calls.jsonl (default: ${DEFAULT_LOG_PATH})`,
  );
  console.log("  --encoding  Tokenizer encoding (default: cl100k_base)");
}

function readJsonFile<T>(filePath: string): T {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as T;
}

function normalizeTools(input: unknown): ToolInfo[] {
  const tools: ToolLike[] = [];

  if (Array.isArray(input)) {
    tools.push(...input);
  } else if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (Array.isArray(obj.tools)) {
      tools.push(...(obj.tools as ToolLike[]));
    } else if (Array.isArray(obj.functions)) {
      tools.push(...(obj.functions as ToolLike[]));
    } else if (Array.isArray(obj.availableTools)) {
      tools.push(...(obj.availableTools as ToolLike[]));
    }
  }

  return tools
    .map((tool) => {
      const name = tool.name ?? tool.function?.name ?? "";
      const description = tool.description ?? tool.function?.description ?? "";
      const parameters =
        tool.inputSchema ?? tool.parameters ?? tool.function?.parameters ?? {};
      return { name, description, parameters };
    })
    .filter((tool) => tool.name.length > 0);
}

function countObjectTokens(
  obj: Record<string, unknown>,
  tokenLength: (value: string) => number,
): number {
  let numTokens = 0;
  for (const [key, value] of Object.entries(obj)) {
    if (!value) {
      continue;
    }
    numTokens += tokenLength(key);
    if (typeof value === "string") {
      numTokens += tokenLength(value);
    } else if (typeof value === "object") {
      numTokens += countObjectTokens(
        value as Record<string, unknown>,
        tokenLength,
      );
    }
  }
  return numTokens;
}

function computeLeafSumTokens(
  tools: ToolInfo[],
  tokenLength: (value: string) => number,
): number {
  const baseToolTokens = 16;
  const baseTokensPerTool = 8;
  let numTokens = tools.length ? baseToolTokens : 0;

  for (const tool of tools) {
    numTokens += baseTokensPerTool;
    numTokens += countObjectTokens(
      {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
      tokenLength,
    );
  }

  return Math.floor(numTokens * 1.1);
}

function computeSerializedTokens(
  tools: ToolInfo[],
  tokenLength: (value: string) => number,
): number {
  let total = 0;
  for (const tool of tools) {
    total += tokenLength(tool.name);
    total += tokenLength(tool.description);
    total += tokenLength(JSON.stringify(tool.parameters ?? {}));
  }
  return total;
}

function computeFullToolJsonTokens(
  tools: ToolInfo[],
  tokenLength: (value: string) => number,
): number {
  let total = 0;
  for (const tool of tools) {
    const json = JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    });
    total += tokenLength(json);
  }
  return total;
}

function readStringTokenTotal(
  logPath: string,
): { count: number; total: number } | null {
  if (!fs.existsSync(logPath)) {
    return null;
  }
  const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  let count = 0;
  let total = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as { type?: string; estimate?: number };
      if (entry.type === "string" && typeof entry.estimate === "number") {
        count += 1;
        total += entry.estimate;
      }
    } catch {
      // Ignore malformed lines.
    }
  }
  return { count, total };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!options.toolsPath) {
    printUsage();
    process.exit(1);
  }

  const toolsRaw = readJsonFile<unknown>(options.toolsPath);
  const tools = normalizeTools(toolsRaw);
  if (tools.length === 0) {
    console.error("No tools found in provided JSON.");
    process.exit(1);
  }

  const encoding = getEncoding(options.encodingName);
  const tokenLength = (value: string): number => encoding.encode(value).length;

  const leafSumTokens = computeLeafSumTokens(tools, tokenLength);
  const serializedTokens = computeSerializedTokens(tools, tokenLength);
  const fullJsonTokens = computeFullToolJsonTokens(tools, tokenLength);

  const logPath = options.logPath ?? DEFAULT_LOG_PATH;
  const logTotals = readStringTokenTotal(logPath);

  console.log("\nTool schema token accounting\n");
  console.log(`Tools: ${tools.length}`);
  console.log(`Encoding: ${options.encodingName}`);
  console.log("\nComputed totals:");
  console.log(`- Leaf-sum (extChatTokenizer): ${leafSumTokens}`);
  console.log(`- Name + description + JSON(schema): ${serializedTokens}`);
  console.log(`- JSON({name,description,parameters}) sum: ${fullJsonTokens}`);

  if (logTotals) {
    console.log("\nLog totals:");
    console.log(`- String calls: ${logTotals.count}`);
    console.log(`- String token total: ${logTotals.total}`);
  } else {
    console.log("\nLog totals: not found (pass --log to override)");
  }

  if (serializedTokens > 0) {
    const ratio = leafSumTokens / serializedTokens;
    console.log("\nRatios:");
    console.log(`- Leaf-sum / serialized: ${ratio.toFixed(2)}x`);
  }

  if (typeof encoding.free === "function") {
    encoding.free();
  }
}

main();
