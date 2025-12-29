import type { LanguageModelV3FunctionTool, LanguageModelV3Middleware } from "@ai-sdk/provider";
import { z } from "zod";
import { createVirtualFilesystem } from "./filesystem";
import { generateCompactPrompt, generateSystemPrompt } from "./prompt";
import { createMeshBashTool, createMeshExecTool } from "./sandbox-tools";
import type { MeshTool, ToolRegistry, ToolsmeshOptions } from "./types";

/**
 * Convert a MeshTool to a tool definition compatible with AI SDK V3.
 */
function meshToolToAITool(meshTool: MeshTool): LanguageModelV3FunctionTool {
	// Use Zod v4's native JSON Schema conversion
	const jsonSchema = z.toJSONSchema(meshTool.parameters, {
		target: "draft-07",
	}) as Record<string, unknown>;

	// Remove $schema as AI SDK doesn't need it
	delete jsonSchema.$schema;

	return {
		type: "function",
		name: meshTool.name,
		description: meshTool.description,
		inputSchema: jsonSchema,
	};
}

/**
 * Create a toolsmesh middleware that transforms tools into a virtual filesystem.
 *
 * This middleware:
 * 1. Converts all tools to TypeScript files in a virtual filesystem
 * 2. Replaces tools with mesh_bash and mesh_exec for discovery and execution
 * 3. Injects a system prompt explaining how to use the mesh
 */
export function createToolsmeshMiddleware(options: ToolsmeshOptions): LanguageModelV3Middleware {
	const {
		tools,
		namespace = "tools",
		includeSchemas = true,
		systemPromptPrefix,
		systemPromptSuffix,
		sandbox,
	} = options;

	// Create the virtual filesystem
	const filesystem = createVirtualFilesystem(tools, { namespace, includeSchemas });

	// Create mesh tools
	const meshBash = createMeshBashTool(filesystem);
	const meshExec = createMeshExecTool(tools, filesystem, sandbox);

	// Generate system prompt
	const systemPrompt = generateSystemPrompt(tools, filesystem, {
		prefix: systemPromptPrefix,
		suffix: systemPromptSuffix,
		includeSummary: true,
	});

	return {
		specificationVersion: "v3" as const,
		transformParams: async ({ params }) => {
			// Replace tools with mesh tools
			const meshTools = [meshToolToAITool(meshBash), meshToolToAITool(meshExec)];

			// Inject system prompt
			const existingPrompt = params.prompt;
			const enhancedPrompt = [...existingPrompt];

			// Find or create system message
			const systemMessageIndex = enhancedPrompt.findIndex((msg) => msg.role === "system");

			if (systemMessageIndex >= 0) {
				// Append to existing system message
				const systemMsg = enhancedPrompt[systemMessageIndex];
				if (systemMsg.role === "system") {
					enhancedPrompt[systemMessageIndex] = {
						...systemMsg,
						content: `${systemMsg.content}\n\n${systemPrompt}`,
					};
				}
			} else {
				// Prepend new system message
				enhancedPrompt.unshift({
					role: "system",
					content: systemPrompt,
				});
			}

			return {
				...params,
				prompt: enhancedPrompt,
				tools: meshTools,
			};
		},

		wrapGenerate: async ({ doGenerate }) => {
			// Execute the generation
			const result = await doGenerate();

			// Process any tool calls and execute mesh tools
			// Note: Tool execution is typically handled by the application layer
			// This middleware primarily transforms the tools available
			return result;
		},

		wrapStream: async ({ doStream }) => {
			// For streaming, we let the stream pass through
			// Tool results will be handled by the application layer
			return doStream();
		},
	};
}

/**
 * Create a toolsmesh with tools ready to use.
 *
 * Returns the mesh tools and filesystem without middleware integration.
 * Useful for manual integration or testing.
 */
export function createToolsmesh(options: ToolsmeshOptions): {
	filesystem: ReturnType<typeof createVirtualFilesystem>;
	tools: {
		mesh_bash: MeshTool;
		mesh_exec: MeshTool;
	};
	systemPrompt: string;
	compactPrompt: string;
} {
	const { tools, namespace = "tools", includeSchemas = true, sandbox } = options;

	const filesystem = createVirtualFilesystem(tools, { namespace, includeSchemas });
	const meshBash = createMeshBashTool(filesystem);
	const meshExec = createMeshExecTool(tools, filesystem, sandbox);

	return {
		filesystem,
		tools: {
			mesh_bash: meshBash,
			mesh_exec: meshExec,
		},
		systemPrompt: generateSystemPrompt(tools, filesystem, {
			prefix: options.systemPromptPrefix,
			suffix: options.systemPromptSuffix,
		}),
		compactPrompt: generateCompactPrompt(tools, filesystem),
	};
}

/**
 * Extract tool definitions from AI SDK tool format.
 *
 * Converts from AI SDK's CoreTool format to our internal ToolRegistry.
 */
export function extractTools(
	aiSdkTools: Record<
		string,
		{
			description?: string;
			parameters: unknown;
			execute?: (params: unknown) => Promise<unknown>;
		}
	>,
): ToolRegistry {
	const registry: ToolRegistry = {};

	for (const [name, tool] of Object.entries(aiSdkTools)) {
		// Assume parameters is a Zod schema
		registry[name] = {
			description: tool.description ?? `Tool: ${name}`,
			parameters: tool.parameters as ToolRegistry[string]["parameters"],
			execute: tool.execute as ToolRegistry[string]["execute"],
		};
	}

	return registry;
}
