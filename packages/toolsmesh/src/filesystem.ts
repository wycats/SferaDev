import { z } from "zod";
import type {
	GeneratedToolInterface,
	ToolDefinition,
	ToolRegistry,
	VirtualFile,
	VirtualFilesystem,
} from "./types";

/**
 * Convert a JSON Schema type to TypeScript type string.
 */
function jsonSchemaToTs(schema: Record<string, unknown>, indent = 0): string {
	const pad = "  ".repeat(indent);

	if (schema.type === "string") {
		if (schema.enum) {
			return (schema.enum as string[]).map((v) => `"${v}"`).join(" | ");
		}
		return "string";
	}
	if (schema.type === "number" || schema.type === "integer") {
		return "number";
	}
	if (schema.type === "boolean") {
		return "boolean";
	}
	if (schema.type === "null") {
		return "null";
	}
	if (schema.type === "array") {
		const items = schema.items as Record<string, unknown> | undefined;
		if (items) {
			return `Array<${jsonSchemaToTs(items, indent)}>`;
		}
		return "unknown[]";
	}
	if (schema.type === "object" || schema.properties) {
		const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
		if (!properties || Object.keys(properties).length === 0) {
			return "Record<string, unknown>";
		}
		const required = (schema.required as string[]) ?? [];
		const lines = Object.entries(properties).map(([key, prop]) => {
			const isOptional = !required.includes(key);
			const desc = prop.description ? ` // ${prop.description}` : "";
			return `${pad}  ${key}${isOptional ? "?" : ""}: ${jsonSchemaToTs(prop, indent + 1)};${desc}`;
		});
		return `{\n${lines.join("\n")}\n${pad}}`;
	}
	if (schema.anyOf) {
		return (schema.anyOf as Record<string, unknown>[])
			.map((s) => jsonSchemaToTs(s, indent))
			.join(" | ");
	}
	if (schema.oneOf) {
		return (schema.oneOf as Record<string, unknown>[])
			.map((s) => jsonSchemaToTs(s, indent))
			.join(" | ");
	}
	if (schema.allOf) {
		return (schema.allOf as Record<string, unknown>[])
			.map((s) => jsonSchemaToTs(s, indent))
			.join(" & ");
	}

	return "unknown";
}

/**
 * Generate TypeScript interface for a tool.
 */
function generateToolInterface(name: string, tool: ToolDefinition): GeneratedToolInterface {
	// Use Zod v4's native JSON Schema conversion
	const jsonSchema = z.toJSONSchema(tool.parameters, {
		target: "draft-07",
	}) as Record<string, unknown>;

	const pascalName = name.charAt(0).toUpperCase() + name.slice(1);
	const paramsType = jsonSchemaToTs(jsonSchema);

	const interfaceCode = `/**
 * ${tool.description}
 */
export interface ${pascalName}Params ${paramsType}`;

	const functionSignature = `declare function ${name}(params: ${pascalName}Params): Promise<unknown>;`;

	const importStatement = `import { ${name}, type ${pascalName}Params } from "./tools/${name}";`;

	return {
		name,
		interfaceCode,
		functionSignature,
		importStatement,
	};
}

/**
 * Generate a TypeScript file content for a single tool.
 */
function generateToolFile(name: string, tool: ToolDefinition, includeSchema: boolean): string {
	const iface = generateToolInterface(name, tool);
	const jsonSchema = includeSchema ? z.toJSONSchema(tool.parameters, { target: "draft-07" }) : null;

	const lines: string[] = [
		"// Auto-generated tool definition",
		"// Use this file to understand the tool's interface",
		"",
		`// Tool: ${name}`,
		`// Description: ${tool.description}`,
		"",
		iface.interfaceCode,
		"",
		"// Function signature:",
		iface.functionSignature,
		"",
		"// Usage example:",
		`// const result = await ${name}({`,
		"//   // ... parameters",
		"// });",
	];

	if (jsonSchema) {
		lines.push(
			"",
			"// JSON Schema:",
			`// ${JSON.stringify(jsonSchema, null, 2).split("\n").join("\n// ")}`,
		);
	}

	return lines.join("\n");
}

/**
 * Generate the tools index file listing all available tools.
 */
function generateToolsIndex(tools: ToolRegistry): string {
	const toolNames = Object.keys(tools).sort();

	const lines: string[] = [
		"// Tool Registry Index",
		"// This file lists all available tools in the mesh.",
		"// Use grep/find to search for specific tools by description.",
		"",
		"// Available tools:",
		...toolNames.map((name) => {
			const tool = tools[name];
			return `//   - ${name}: ${tool.description}`;
		}),
		"",
		"// Quick reference:",
		...toolNames.map((name) => `export * from "./${name}";`),
	];

	return lines.join("\n");
}

/**
 * Generate a README file explaining how to use the mesh.
 */
function generateReadme(namespace: string, toolCount: number): string {
	return `# Toolsmesh Virtual Filesystem

This directory contains ${toolCount} tools organized as TypeScript files.

## Directory Structure

\`\`\`
/${namespace}/
├── index.ts          # Lists all available tools
├── README.md         # This file
└── <tool-name>.ts    # Individual tool definitions
\`\`\`

## How to Use

1. **List all tools**: Use \`ls /${namespace}\` to see all tool files
2. **Search by description**: Use \`grep "keyword" /${namespace}\` to find tools
3. **Read tool details**: Use \`cat /${namespace}/<tool>.ts\` to see full interface
4. **Find tools**: Use \`find /${namespace} -name "*pattern*"\` to locate tools
5. **Execute code**: Use \`exec\` to run TypeScript code that calls tools

## Writing Code

When using \`exec\`, you can import and call tools:

\`\`\`typescript
// Tools are available as async functions
const result = await toolName({ param1: "value" });
console.log(result);
\`\`\`

The execution environment is sandboxed. All tool calls are validated against
their TypeScript interfaces for type safety.
`;
}

/**
 * Create a virtual filesystem from a tool registry.
 */
export function createVirtualFilesystem(
	tools: ToolRegistry,
	options: { namespace?: string; includeSchemas?: boolean } = {},
): VirtualFilesystem {
	const namespace = options.namespace ?? "tools";
	const includeSchemas = options.includeSchemas ?? true;
	const files = new Map<string, VirtualFile>();

	// Create root directory
	files.set(`/${namespace}`, {
		path: `/${namespace}`,
		content: "",
		isDirectory: true,
	});

	// Create tool files
	for (const [name, tool] of Object.entries(tools)) {
		const path = `/${namespace}/${name}.ts`;
		files.set(path, {
			path,
			content: generateToolFile(name, tool, includeSchemas),
			isDirectory: false,
		});
	}

	// Create index file
	files.set(`/${namespace}/index.ts`, {
		path: `/${namespace}/index.ts`,
		content: generateToolsIndex(tools),
		isDirectory: false,
	});

	// Create README
	files.set(`/${namespace}/README.md`, {
		path: `/${namespace}/README.md`,
		content: generateReadme(namespace, Object.keys(tools).length),
		isDirectory: false,
	});

	return {
		files,
		root: `/${namespace}`,
	};
}

/**
 * List files in a directory.
 */
export function listDirectory(fs: VirtualFilesystem, path: string): VirtualFile[] {
	const normalizedPath = path.endsWith("/") ? path.slice(0, -1) : path;
	const results: VirtualFile[] = [];

	for (const file of fs.files.values()) {
		// Check if file is directly in this directory
		const parentPath = file.path.substring(0, file.path.lastIndexOf("/"));
		if (parentPath === normalizedPath || (normalizedPath === "" && parentPath === "")) {
			results.push(file);
		}
	}

	return results.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Read a file from the filesystem.
 */
export function readFile(fs: VirtualFilesystem, path: string): VirtualFile | null {
	return fs.files.get(path) ?? null;
}

/**
 * Search for files matching a pattern.
 */
export function findFiles(
	fs: VirtualFilesystem,
	pattern: string,
	basePath?: string,
): VirtualFile[] {
	const regex = new RegExp(pattern.replace(/\*/g, ".*").replace(/\?/g, "."), "i");
	const results: VirtualFile[] = [];

	for (const file of fs.files.values()) {
		if (basePath && !file.path.startsWith(basePath)) {
			continue;
		}
		const fileName = file.path.substring(file.path.lastIndexOf("/") + 1);
		if (regex.test(fileName) || regex.test(file.path)) {
			results.push(file);
		}
	}

	return results.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Search file contents for a pattern.
 */
export function grepFiles(
	fs: VirtualFilesystem,
	pattern: string,
	basePath?: string,
	maxResults = 50,
): Array<{ file: VirtualFile; matches: string[] }> {
	const regex = new RegExp(pattern, "gi");
	const results: Array<{ file: VirtualFile; matches: string[] }> = [];

	for (const file of fs.files.values()) {
		if (file.isDirectory) continue;
		if (basePath && !file.path.startsWith(basePath)) continue;

		const matches: string[] = [];
		const lines = file.content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			if (regex.test(lines[i])) {
				matches.push(`${i + 1}: ${lines[i]}`);
				regex.lastIndex = 0; // Reset regex state
			}
		}

		if (matches.length > 0) {
			results.push({ file, matches });
			if (results.length >= maxResults) break;
		}
	}

	return results;
}
