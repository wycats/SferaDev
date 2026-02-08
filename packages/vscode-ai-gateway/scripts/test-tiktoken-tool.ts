import { getEncoding } from "js-tiktoken";
const encoding = getEncoding("cl100k_base");

const sampleTool = {
  name: "create_directory",
  description:
    "Create a new directory structure in the workspace. Will recursively create all directories in the path, like mkdir -p. You do not need to use this tool before using create_file, that tool will automatically create the needed directories.",
  inputSchema: {
    type: "object",
    properties: {
      dirPath: {
        type: "string",
        description: "The absolute path to the directory to create.",
      },
    },
    required: ["dirPath"],
  },
};

const nameTokens = encoding.encode(sampleTool.name).length;
const descTokens = encoding.encode(sampleTool.description).length;
const schemaTokens = encoding.encode(
  JSON.stringify(sampleTool.inputSchema),
).length;
const totalTokens = nameTokens + descTokens + schemaTokens;

console.log("Sample tool: create_directory");
console.log("Name chars:", sampleTool.name.length, "→ tokens:", nameTokens);
console.log(
  "Desc chars:",
  sampleTool.description.length,
  "→ tokens:",
  descTokens,
);
console.log(
  "Schema chars:",
  JSON.stringify(sampleTool.inputSchema).length,
  "→ tokens:",
  schemaTokens,
);
console.log("Total:", totalTokens, "tokens");
console.log("");
console.log(
  "Chars:",
  sampleTool.name.length +
    sampleTool.description.length +
    JSON.stringify(sampleTool.inputSchema).length,
);
console.log(
  "Chars/4:",
  Math.ceil(
    (sampleTool.name.length +
      sampleTool.description.length +
      JSON.stringify(sampleTool.inputSchema).length) /
      4,
  ),
);
console.log("Tiktoken:", totalTokens);
console.log(
  "Ratio:",
  (
    totalTokens /
    Math.ceil(
      (sampleTool.name.length +
        sampleTool.description.length +
        JSON.stringify(sampleTool.inputSchema).length) /
        4,
    )
  ).toFixed(2),
);

encoding.free();
