/**
 * Toolsmesh - A virtual filesystem wrapper for AI SDK tools
 *
 * Converts tools into a discoverable filesystem that models can explore
 * using bash-like commands and execute using TypeScript code.
 *
 * @example
 * ```typescript
 * import { wrapLanguageModel } from "ai";
 * import { createToolsmeshMiddleware } from "toolsmesh";
 * import { z } from "zod";
 *
 * // Define your tools
 * const tools = {
 *   createUser: {
 *     description: "Create a new user account",
 *     parameters: z.object({
 *       name: z.string(),
 *       email: z.string().email(),
 *     }),
 *     execute: async ({ name, email }) => {
 *       // Implementation
 *       return { id: "123", name, email };
 *     },
 *   },
 * };
 *
 * // Create the middleware
 * const middleware = createToolsmeshMiddleware({ tools });
 *
 * // Wrap your model
 * const model = wrapLanguageModel({
 *   model: yourBaseModel,
 *   middleware,
 * });
 * ```
 *
 * @packageDocumentation
 */

// Compaction utilities
export {
	analyzeCompaction,
	type CompactableMessage,
	type CompactionBoundary,
	type CompactionResult,
	type CompactionStrategy,
	type CompactOptions,
	cleanupAllSessions,
	cleanupSession,
	compact,
	createCompactor,
	listSessions,
	type ToolResultMessage,
} from "./compaction";

// Filesystem utilities (for advanced usage)
export {
	createVirtualFilesystem,
	findFiles,
	grepFiles,
	listDirectory,
	readFile,
} from "./filesystem";

// Core exports
export {
	createToolsmesh,
	createToolsmeshMiddleware,
	extractTools,
} from "./middleware";

// Prompt utilities (for customization)
export {
	generateCompactPrompt,
	generateSystemPrompt,
	type SystemPromptOptions,
} from "./prompt";

// Sandbox tools (for manual integration)
export {
	createMeshBashTool,
	createMeshExecTool,
	createMeshTools,
} from "./sandbox-tools";

// Types
export type {
	GeneratedToolInterface,
	MeshTool,
	SandboxConfig,
	ToolDefinition,
	ToolRegistry,
	ToolsmeshOptions,
	TypeInfo,
	VirtualFile,
	VirtualFilesystem,
} from "./types";
