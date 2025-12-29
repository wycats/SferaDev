import type { ZodType, z } from "zod";

/**
 * A tool definition that can be converted to a virtual filesystem.
 * Compatible with AI SDK's CoreTool interface.
 */
export type ToolDefinition<TParams extends ZodType = ZodType> = {
	/** Tool description for discovery */
	description: string;
	/** Zod schema for parameters */
	parameters: TParams;
	/** Optional execute function - if provided, tool can be called */
	execute?: (params: z.infer<TParams>) => Promise<unknown>;
};

/**
 * A collection of tools keyed by name.
 */
export type ToolRegistry = Record<string, ToolDefinition>;

/**
 * Virtual file in the mesh filesystem.
 */
export type VirtualFile = {
	/** File path relative to root */
	path: string;
	/** File content */
	content: string;
	/** Whether this is a directory */
	isDirectory: boolean;
};

/**
 * Virtual filesystem for tools.
 */
export type VirtualFilesystem = {
	/** All files in the filesystem */
	files: Map<string, VirtualFile>;
	/** Root directory path */
	root: string;
};

/**
 * Configuration for sandbox execution.
 */
export type SandboxConfig = {
	/**
	 * Allow local execution without sandboxing.
	 * WARNING: This is unsafe for untrusted code as it has access to globalThis.
	 * Only use for local development with trusted models.
	 * @default false
	 */
	dangerouslyAllowLocalExecution?: boolean;
};

/**
 * Options for creating the toolsmesh wrapper.
 */
export type ToolsmeshOptions = {
	/**
	 * The tools to expose in the virtual filesystem.
	 */
	tools: ToolRegistry;
	/**
	 * Optional namespace for the tools (affects directory structure).
	 * @default "tools"
	 */
	namespace?: string;
	/**
	 * Whether to include full JSON schemas in generated files.
	 * Set to false for more compact output.
	 * @default true
	 */
	includeSchemas?: boolean;
	/**
	 * Custom system prompt to prepend to the generated prompt.
	 */
	systemPromptPrefix?: string;
	/**
	 * Custom system prompt to append to the generated prompt.
	 */
	systemPromptSuffix?: string;
	/**
	 * Sandbox configuration for code execution.
	 */
	sandbox?: SandboxConfig;
};

/**
 * A mesh tool that operates on the virtual filesystem.
 */
export type MeshTool = {
	name: string;
	description: string;
	parameters: ZodType;
	execute: (params: unknown) => Promise<string>;
};

/**
 * TypeScript type information for a tool parameter.
 */
export type TypeInfo = {
	/** TypeScript type string */
	type: string;
	/** Whether the parameter is optional */
	optional: boolean;
	/** Description from the schema */
	description?: string;
};

/**
 * Generated TypeScript interface for a tool.
 */
export type GeneratedToolInterface = {
	/** Tool name */
	name: string;
	/** Full TypeScript interface definition */
	interfaceCode: string;
	/** Function signature for calling the tool */
	functionSignature: string;
	/** Import statement if needed */
	importStatement: string;
};
