import type { VirtualFilesystem } from "./types";

/**
 * Compaction strategy for handling tool results.
 */
export type CompactionStrategy = "write-to-filesystem" | "drop-results";

/**
 * Boundary configuration for controlling which messages get compacted.
 */
export type CompactionBoundary =
	| "all"
	| { type: "keep-first"; count: number }
	| { type: "keep-last"; count: number }
	| { type: "after-index"; index: number };

/**
 * Options for the compact function.
 */
export type CompactOptions = {
	/**
	 * Strategy for handling tool results.
	 * - "write-to-filesystem": Store results in the virtual filesystem with references
	 * - "drop-results": Remove results entirely with a placeholder
	 * @default "write-to-filesystem"
	 */
	strategy?: CompactionStrategy;
	/**
	 * Controls which messages get compacted.
	 * - "all": Compact all tool results
	 * - { type: "keep-first", count: N }: Keep first N messages uncompacted
	 * - { type: "keep-last", count: N }: Keep last N messages uncompacted
	 * - { type: "after-index", index: N }: Only compact messages after index N
	 * @default "all"
	 */
	boundary?: CompactionBoundary;
	/**
	 * Session ID for organizing stored results.
	 * @default "default"
	 */
	sessionId?: string;
	/**
	 * Minimum result size (in characters) to trigger compaction.
	 * Results smaller than this are kept inline.
	 * @default 500
	 */
	minSize?: number;
	/**
	 * Tool names that should never be compacted (e.g., mesh_bash, mesh_exec).
	 * @default ["mesh_bash", "mesh_exec"]
	 */
	excludeTools?: string[];
};

/**
 * A message with tool result content.
 */
export type ToolResultMessage = {
	role: "tool";
	content: Array<{
		type: "tool-result";
		toolCallId: string;
		toolName: string;
		result: unknown;
	}>;
};

/**
 * Generic message type for compaction.
 */
export type CompactableMessage =
	| { role: "system" | "user" | "assistant"; content: unknown }
	| ToolResultMessage;

/**
 * Result of compaction operation.
 */
export type CompactionResult = {
	/** Compacted messages */
	messages: CompactableMessage[];
	/** Number of results compacted */
	compactedCount: number;
	/** Total bytes saved (approximate) */
	bytesSaved: number;
	/** Paths to stored results (for write-to-filesystem strategy) */
	storedPaths: string[];
};

/**
 * Compact tool results in a message array to reduce context size.
 *
 * @example
 * ```typescript
 * const { messages, filesystem } = await compact(originalMessages, filesystem, {
 *   strategy: "write-to-filesystem",
 *   boundary: { type: "keep-last", count: 5 },
 *   minSize: 1000,
 * });
 * ```
 */
export function compact(
	messages: CompactableMessage[],
	filesystem: VirtualFilesystem,
	options: CompactOptions = {},
): CompactionResult {
	const {
		strategy = "write-to-filesystem",
		boundary = "all",
		sessionId = "default",
		minSize = 500,
		excludeTools = ["mesh_bash", "mesh_exec"],
	} = options;

	const result: CompactionResult = {
		messages: [],
		compactedCount: 0,
		bytesSaved: 0,
		storedPaths: [],
	};

	// Determine which indices should be compacted based on boundary
	const compactableIndices = getCompactableIndices(messages, boundary);

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];

		// Check if this message should be compacted
		if (!compactableIndices.has(i)) {
			result.messages.push(message);
			continue;
		}

		// Only compact tool result messages
		if (message.role !== "tool") {
			result.messages.push(message);
			continue;
		}

		const toolMessage = message as ToolResultMessage;
		const compactedContent: ToolResultMessage["content"] = [];

		for (const item of toolMessage.content) {
			if (item.type !== "tool-result") {
				compactedContent.push(item);
				continue;
			}

			// Skip excluded tools
			if (excludeTools.includes(item.toolName)) {
				compactedContent.push(item);
				continue;
			}

			// Check result size
			const resultStr = stringifyResult(item.result);
			if (resultStr.length < minSize) {
				compactedContent.push(item);
				continue;
			}

			// Apply compaction strategy
			if (strategy === "write-to-filesystem") {
				const path = writeResultToFilesystem(
					filesystem,
					sessionId,
					item.toolName,
					item.toolCallId,
					item.result,
				);
				result.storedPaths.push(path);

				compactedContent.push({
					...item,
					result: createFileReference(path, resultStr.length),
				});
			} else {
				// drop-results strategy
				compactedContent.push({
					...item,
					result: createDroppedPlaceholder(item.toolName, resultStr.length),
				});
			}

			result.compactedCount++;
			result.bytesSaved += resultStr.length;
		}

		result.messages.push({
			role: "tool",
			content: compactedContent,
		});
	}

	return result;
}

/**
 * Get the set of message indices that should be compacted based on boundary.
 */
function getCompactableIndices(
	messages: CompactableMessage[],
	boundary: CompactionBoundary,
): Set<number> {
	const indices = new Set<number>();
	const len = messages.length;

	if (boundary === "all") {
		for (let i = 0; i < len; i++) {
			indices.add(i);
		}
	} else if (boundary.type === "keep-first") {
		for (let i = boundary.count; i < len; i++) {
			indices.add(i);
		}
	} else if (boundary.type === "keep-last") {
		for (let i = 0; i < len - boundary.count; i++) {
			indices.add(i);
		}
	} else if (boundary.type === "after-index") {
		for (let i = boundary.index + 1; i < len; i++) {
			indices.add(i);
		}
	}

	return indices;
}

/**
 * Stringify a result for size calculation and storage.
 */
function stringifyResult(result: unknown): string {
	if (typeof result === "string") return result;
	try {
		return JSON.stringify(result, null, 2);
	} catch {
		return String(result);
	}
}

/**
 * Write a tool result to the virtual filesystem.
 */
function writeResultToFilesystem(
	filesystem: VirtualFilesystem,
	sessionId: string,
	toolName: string,
	toolCallId: string,
	result: unknown,
): string {
	const resultStr = stringifyResult(result);
	const timestamp = Date.now();
	const shortId = toolCallId.slice(-8);

	// Create compact directory structure
	const compactDir = `${filesystem.root}/compact`;
	const sessionDir = `${compactDir}/${sessionId}`;
	const resultsDir = `${sessionDir}/results`;

	// Ensure directories exist
	ensureDirectory(filesystem, compactDir);
	ensureDirectory(filesystem, sessionDir);
	ensureDirectory(filesystem, resultsDir);

	// Create result file
	const fileName = `${toolName}_${shortId}_${timestamp}.json`;
	const filePath = `${resultsDir}/${fileName}`;

	filesystem.files.set(filePath, {
		path: filePath,
		content: resultStr,
		isDirectory: false,
	});

	return filePath;
}

/**
 * Ensure a directory exists in the filesystem.
 */
function ensureDirectory(filesystem: VirtualFilesystem, path: string): void {
	if (!filesystem.files.has(path)) {
		filesystem.files.set(path, {
			path,
			content: "",
			isDirectory: true,
		});
	}
}

/**
 * Create a reference message pointing to the stored file.
 */
function createFileReference(path: string, originalSize: number): string {
	return `[Result stored in filesystem - ${formatBytes(originalSize)}]
Path: ${path}
Use mesh_bash to retrieve: cat ${path}`;
}

/**
 * Create a placeholder for dropped results.
 */
function createDroppedPlaceholder(toolName: string, originalSize: number): string {
	return `[Result dropped to preserve context - ${formatBytes(originalSize)}]
Tool: ${toolName}
Note: Result was removed to save tokens. Re-call the tool if needed.`;
}

/**
 * Format bytes to human-readable string.
 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} bytes`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Create a compaction middleware that automatically compacts messages.
 *
 * This can be used with AI SDK's prepareStep callback.
 *
 * @example
 * ```typescript
 * const compactor = createCompactor(filesystem, {
 *   strategy: "write-to-filesystem",
 *   boundary: { type: "keep-last", count: 3 },
 * });
 *
 * // In your agent loop
 * prepareStep: async ({ messages }) => {
 *   const { messages: compacted } = compactor(messages);
 *   return { messages: compacted };
 * }
 * ```
 */
export function createCompactor(
	filesystem: VirtualFilesystem,
	options: CompactOptions = {},
): (messages: CompactableMessage[]) => CompactionResult {
	return (messages) => compact(messages, filesystem, options);
}

/**
 * Clean up compacted results for a specific session.
 * Call this when a session ends to free up filesystem space.
 *
 * @example
 * ```typescript
 * // Clean up a specific session
 * cleanupSession(filesystem, "my-session-id");
 *
 * // Clean up the default session
 * cleanupSession(filesystem);
 * ```
 */
export function cleanupSession(
	filesystem: VirtualFilesystem,
	sessionId = "default",
): { deletedCount: number; deletedPaths: string[] } {
	const prefix = `${filesystem.root}/compact/${sessionId}`;
	const deletedPaths: string[] = [];

	for (const path of filesystem.files.keys()) {
		if (path.startsWith(prefix)) {
			filesystem.files.delete(path);
			deletedPaths.push(path);
		}
	}

	return {
		deletedCount: deletedPaths.length,
		deletedPaths,
	};
}

/**
 * Clean up all compacted results across all sessions.
 * Use with caution in multi-tenant environments.
 *
 * @example
 * ```typescript
 * const { deletedCount } = cleanupAllSessions(filesystem);
 * console.log(`Cleaned up ${deletedCount} files`);
 * ```
 */
export function cleanupAllSessions(filesystem: VirtualFilesystem): {
	deletedCount: number;
	deletedPaths: string[];
} {
	const prefix = `${filesystem.root}/compact`;
	const deletedPaths: string[] = [];

	for (const path of filesystem.files.keys()) {
		if (path.startsWith(prefix)) {
			filesystem.files.delete(path);
			deletedPaths.push(path);
		}
	}

	return {
		deletedCount: deletedPaths.length,
		deletedPaths,
	};
}

/**
 * List all active sessions with compacted results.
 *
 * @example
 * ```typescript
 * const sessions = listSessions(filesystem);
 * // ["default", "user-123", "agent-456"]
 * ```
 */
export function listSessions(filesystem: VirtualFilesystem): string[] {
	const compactPrefix = `${filesystem.root}/compact/`;
	const sessions = new Set<string>();

	for (const path of filesystem.files.keys()) {
		if (path.startsWith(compactPrefix)) {
			// Extract session ID from path like /tools/compact/sessionId/results/file.json
			const relativePath = path.slice(compactPrefix.length);
			const sessionId = relativePath.split("/")[0];
			if (sessionId) {
				sessions.add(sessionId);
			}
		}
	}

	return Array.from(sessions).sort();
}

/**
 * Get statistics about potential compaction savings.
 */
export function analyzeCompaction(
	messages: CompactableMessage[],
	options: Pick<CompactOptions, "minSize" | "excludeTools"> = {},
): {
	totalToolResults: number;
	compactableResults: number;
	estimatedSavings: number;
	largestResult: { toolName: string; size: number } | null;
} {
	const { minSize = 500, excludeTools = ["mesh_bash", "mesh_exec"] } = options;

	let totalToolResults = 0;
	let compactableResults = 0;
	let estimatedSavings = 0;
	let largestResult: { toolName: string; size: number } | null = null;

	for (const message of messages) {
		if (message.role !== "tool") continue;

		const toolMessage = message as ToolResultMessage;
		for (const item of toolMessage.content) {
			if (item.type !== "tool-result") continue;

			totalToolResults++;
			const resultStr = stringifyResult(item.result);
			const size = resultStr.length;

			if (!largestResult || size > largestResult.size) {
				largestResult = { toolName: item.toolName, size };
			}

			if (!excludeTools.includes(item.toolName) && size >= minSize) {
				compactableResults++;
				estimatedSavings += size;
			}
		}
	}

	return {
		totalToolResults,
		compactableResults,
		estimatedSavings,
		largestResult,
	};
}
