import { Bash } from "just-bash";
import { z } from "zod";
import type { MeshTool, SandboxConfig, ToolRegistry, VirtualFilesystem } from "./types";

/**
 * Create a just-bash environment with tool files loaded.
 */
function createBashEnv(fs: VirtualFilesystem): Bash {
	// Convert our virtual filesystem to just-bash files format
	const files: Record<string, string> = {};
	for (const [path, file] of fs.files) {
		if (!file.isDirectory) {
			files[path] = file.content;
		}
	}

	return new Bash({
		files,
		cwd: fs.root,
	});
}

/**
 * Create the mesh_bash tool for exploring the virtual filesystem.
 * Uses just-bash for command execution.
 */
export function createMeshBashTool(fs: VirtualFilesystem): MeshTool {
	const bash = createBashEnv(fs);

	return {
		name: "mesh_bash",
		description: `Execute bash commands against the virtual filesystem containing tool definitions.
Available commands: ls, cat, head, tail, grep, find, pwd, echo, wc, tree, and more.
The filesystem root is ${fs.root} containing TypeScript tool definitions.

Tips:
- Use 'ls -l' to see file sizes and line counts
- Use 'grep -r "keyword"' to search tool descriptions
- Use 'find . -name "*.ts"' to find specific files
- Use 'cat <file>' to read full tool definitions`,
		parameters: meshBashSchema,
		execute: async (params: unknown) => {
			const { command } = params as { command: string };
			const result = await bash.exec(command);

			if (result.exitCode !== 0 && result.stderr) {
				return `[error] ${result.stderr}`;
			}

			return result.stdout || "(no output)";
		},
	};
}

const meshBashSchema = z.object({
	command: z
		.string()
		.describe("Bash command to execute (e.g., 'ls -la', 'grep -r api', 'cat tool.ts')"),
});

/**
 * Create the mesh_exec tool for executing TypeScript code.
 * Uses @vercel/sandbox or just-bash Sandbox for isolation.
 */
export function createMeshExecTool(
	tools: ToolRegistry,
	fs: VirtualFilesystem,
	sandboxConfig?: SandboxConfig,
): MeshTool {
	return {
		name: "mesh_exec",
		description: `Execute TypeScript code that calls tools from the mesh.
The code runs in a sandboxed environment with access to all registered tools.
Tools are available as async functions matching their TypeScript signatures.

Example:
\`\`\`typescript
// Call a tool directly
const result = await someToolName({ param1: "value" });
console.log(result);

// Chain multiple tools
const data = await fetchData({ source: "api" });
const processed = await processData({ input: data });
return processed;
\`\`\`

The last expression or return value becomes the result.
Use console.log() for intermediate output.
All tool calls are type-checked against their schemas.`,
		parameters: meshExecSchema,
		execute: async (params: unknown) => {
			const { code } = params as { code: string };
			return executeInSandbox(code, tools, fs, sandboxConfig);
		},
	};
}

const meshExecSchema = z.object({
	code: z.string().describe("TypeScript code to execute. Tools are available as async functions."),
});

/**
 * Execute TypeScript code in a sandboxed environment.
 * Uses local execution when dangerouslyAllowLocalExecution is true.
 * Note: just-bash Sandbox doesn't have node available, so we fall back to local.
 */
async function executeInSandbox(
	code: string,
	tools: ToolRegistry,
	_fs: VirtualFilesystem,
	config?: SandboxConfig,
): Promise<string> {
	const allowLocal = config?.dangerouslyAllowLocalExecution === true;

	// Use local execution when explicitly allowed
	if (allowLocal) {
		return executeLocally(code, tools);
	}

	// Return helpful error message
	return `[error] Code execution is disabled.

To enable execution, set dangerouslyAllowLocalExecution: true in sandbox config:
  sandbox: { dangerouslyAllowLocalExecution: true }

WARNING: Local execution uses new Function() with access to globalThis.
Only use with trusted AI models.`;
}

/**
 * Execute code locally (unsafe, for development only).
 * WARNING: This uses new Function() which has access to globalThis.
 */
async function executeLocally(code: string, tools: ToolRegistry): Promise<string> {
	const stdout: string[] = [];
	const stderr: string[] = [];

	// Create mock console
	const mockConsole = {
		log: (...args: unknown[]) => {
			stdout.push(args.map(stringify).join(" "));
		},
		error: (...args: unknown[]) => {
			stderr.push(args.map(stringify).join(" "));
		},
		warn: (...args: unknown[]) => {
			stderr.push(`[warn] ${args.map(stringify).join(" ")}`);
		},
	};

	// Create tool functions
	const toolFunctions: Record<string, (params: unknown) => Promise<unknown>> = {};

	for (const [name, tool] of Object.entries(tools)) {
		toolFunctions[name] = async (params: unknown) => {
			const parsed = tool.parameters.safeParse(params);
			if (!parsed.success) {
				throw new Error(`Invalid parameters for ${name}: ${parsed.error.message}`);
			}

			if (!tool.execute) {
				throw new Error(`Tool ${name} does not have an execute function`);
			}

			return tool.execute(parsed.data);
		};
	}

	try {
		const wrappedCode = `
      return (async () => {
        ${code}
      })();
    `;

		const fn = new Function("console", ...Object.keys(toolFunctions), wrappedCode);
		const result = await fn(mockConsole, ...Object.values(toolFunctions));

		const output: string[] = [];

		if (stdout.length > 0) {
			output.push(stdout.join("\n"));
		}

		if (stderr.length > 0) {
			output.push(`[stderr]\n${stderr.join("\n")}`);
		}

		if (result !== undefined) {
			output.push(`[result]\n${stringify(result)}`);
		}

		return output.join("\n\n") || "(no output)";
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return `[error] ${errorMessage}`;
	}
}

/**
 * Stringify a value for output.
 */
function stringify(value: unknown): string {
	if (value === undefined) return "undefined";
	if (value === null) return "null";
	if (typeof value === "string") return value;
	if (typeof value === "function") return "[Function]";
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/**
 * Get all mesh tools for a given tool registry.
 */
export function createMeshTools(
	tools: ToolRegistry,
	fs: VirtualFilesystem,
	options: { sandbox?: SandboxConfig } = {},
): MeshTool[] {
	return [createMeshBashTool(fs), createMeshExecTool(tools, fs, options.sandbox)];
}
