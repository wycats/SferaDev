import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	analyzeCompaction,
	cleanupAllSessions,
	cleanupSession,
	compact,
	createCompactor,
	listSessions,
} from "./compaction";
import {
	createVirtualFilesystem,
	findFiles,
	grepFiles,
	listDirectory,
	readFile,
} from "./filesystem";
import { createToolsmesh, extractTools } from "./middleware";
import { generateCompactPrompt, generateSystemPrompt } from "./prompt";
import { createMeshBashTool, createMeshExecTool, createMeshTools } from "./sandbox-tools";
import type { ToolRegistry } from "./types";

// Sample tools for testing
const sampleTools: ToolRegistry = {
	createUser: {
		description: "Create a new user account with email verification",
		parameters: z.object({
			name: z.string().describe("Full name of the user"),
			email: z.string().email().describe("Email address"),
			role: z.enum(["admin", "user", "guest"]).optional().describe("User role"),
		}),
		execute: async ({ name, email, role }) => ({
			id: "user_123",
			name,
			email,
			role: role ?? "user",
		}),
	},
	fetchData: {
		description: "Fetch data from an external API endpoint",
		parameters: z.object({
			url: z.string().url().describe("API endpoint URL"),
			method: z.enum(["GET", "POST"]).default("GET"),
		}),
		execute: async ({ url, method }) => ({
			status: 200,
			data: { url, method },
		}),
	},
	processData: {
		description: "Process and transform data using various algorithms",
		parameters: z.object({
			input: z.unknown().describe("Input data to process"),
			algorithm: z.string().describe("Algorithm to use"),
		}),
	},
};

describe("Virtual Filesystem", () => {
	it("creates filesystem with correct structure", () => {
		const fs = createVirtualFilesystem(sampleTools);

		expect(fs.root).toBe("/tools");
		expect(fs.files.size).toBeGreaterThan(0);

		// Check root directory exists
		expect(fs.files.has("/tools")).toBe(true);
		expect(fs.files.get("/tools")?.isDirectory).toBe(true);

		// Check tool files exist
		expect(fs.files.has("/tools/createUser.ts")).toBe(true);
		expect(fs.files.has("/tools/fetchData.ts")).toBe(true);
		expect(fs.files.has("/tools/processData.ts")).toBe(true);

		// Check index and readme
		expect(fs.files.has("/tools/index.ts")).toBe(true);
		expect(fs.files.has("/tools/README.md")).toBe(true);
	});

	it("generates TypeScript interfaces in tool files", () => {
		const fs = createVirtualFilesystem(sampleTools);
		const userFile = fs.files.get("/tools/createUser.ts");

		expect(userFile).toBeDefined();
		expect(userFile?.content).toContain("CreateUserParams");
		expect(userFile?.content).toContain("name");
		expect(userFile?.content).toContain("email");
		expect(userFile?.content).toContain("role");
	});

	it("respects custom namespace", () => {
		const fs = createVirtualFilesystem(sampleTools, { namespace: "mytools" });

		expect(fs.root).toBe("/mytools");
		expect(fs.files.has("/mytools")).toBe(true);
		expect(fs.files.has("/mytools/createUser.ts")).toBe(true);
	});

	it("includes schema by default", () => {
		const fsDefault = createVirtualFilesystem(sampleTools);
		const defaultContent = fsDefault.files.get("/tools/createUser.ts")?.content ?? "";

		// Default includes JSON Schema for better tool discovery via grep
		expect(defaultContent).toContain("JSON Schema");
	});

	it("can disable schema inclusion", () => {
		const fsWithSchema = createVirtualFilesystem(sampleTools, { includeSchemas: true });
		const fsWithoutSchema = createVirtualFilesystem(sampleTools, { includeSchemas: false });

		const withSchema = fsWithSchema.files.get("/tools/createUser.ts")?.content ?? "";
		const withoutSchema = fsWithoutSchema.files.get("/tools/createUser.ts")?.content ?? "";

		expect(withSchema).toContain("JSON Schema");
		expect(withoutSchema).not.toContain("JSON Schema");
	});
});

describe("Filesystem Operations", () => {
	const fs = createVirtualFilesystem(sampleTools);

	it("lists directory contents", () => {
		const files = listDirectory(fs, "/tools");

		expect(files.length).toBeGreaterThan(0);
		expect(files.some((f) => f.path === "/tools/createUser.ts")).toBe(true);
	});

	it("reads file contents", () => {
		const file = readFile(fs, "/tools/createUser.ts");

		expect(file).not.toBeNull();
		expect(file?.content).toContain("Create a new user account");
	});

	it("returns null for non-existent files", () => {
		const file = readFile(fs, "/tools/nonexistent.ts");
		expect(file).toBeNull();
	});

	it("finds files by pattern", () => {
		const files = findFiles(fs, "*User*");

		expect(files.length).toBe(1);
		expect(files[0].path).toBe("/tools/createUser.ts");
	});

	it("greps file contents", () => {
		const results = grepFiles(fs, "email");

		expect(results.length).toBeGreaterThan(0);
		expect(results.some((r) => r.file.path === "/tools/createUser.ts")).toBe(true);
	});
});

describe("Mesh Bash Tool", () => {
	const fs = createVirtualFilesystem(sampleTools);
	const bashTool = createMeshBashTool(fs);

	it("executes ls command", async () => {
		const result = await bashTool.execute({ command: "ls /tools" });

		expect(result).toContain("createUser.ts");
		expect(result).toContain("fetchData.ts");
		expect(result).toContain("index.ts");
	});

	it("executes ls -l command", async () => {
		const result = await bashTool.execute({ command: "ls -l /tools" });

		expect(result).toContain("createUser.ts");
		// just-bash uses standard ls -l format
		expect(result).toContain("user");
	});

	it("executes cat command", async () => {
		const result = await bashTool.execute({ command: "cat /tools/createUser.ts" });

		expect(result).toContain("CreateUserParams");
		expect(result).toContain("Create a new user account");
	});

	it("executes head command", async () => {
		const result = await bashTool.execute({ command: "head -5 /tools/createUser.ts" });

		// just-bash may include trailing newline
		const lines = result.trim().split("\n");
		expect(lines.length).toBeLessThanOrEqual(5);
	});

	it("executes grep command", async () => {
		const result = await bashTool.execute({ command: "grep -r email /tools" });

		expect(result).toContain("/tools/createUser.ts");
		expect(result).toContain("email");
	});

	it("executes find command", async () => {
		const result = await bashTool.execute({ command: "find /tools -name '*User*'" });

		expect(result).toContain("createUser.ts");
	});

	it("executes pwd command", async () => {
		const result = await bashTool.execute({ command: "pwd" });
		expect(result.trim()).toBe("/tools");
	});

	it("executes tree command", async () => {
		const result = await bashTool.execute({ command: "tree /tools" });

		// just-bash tree shows files in the tree structure
		expect(result).toContain("createUser.ts");
		expect(result).toContain("fetchData.ts");
	});

	it("handles unknown commands", async () => {
		const result = await bashTool.execute({ command: "unknown_cmd" });
		expect(result).toContain("command not found");
	});

	it("handles chained commands", async () => {
		const result = await bashTool.execute({ command: "pwd && ls" });

		expect(result).toContain("/tools");
		expect(result).toContain("createUser.ts");
	});

	it("handles very long arguments gracefully", async () => {
		// just-bash handles long commands without crashing
		const longCommand = `ls ${"a".repeat(1000)}`;
		const result = await bashTool.execute({ command: longCommand });

		// Should return some form of error (file not found)
		expect(result).toBeTruthy();
	});
});

describe("Mesh Exec Tool", () => {
	const fs = createVirtualFilesystem(sampleTools);
	// Use dangerouslyAllowLocalExecution for tests (no Vercel sandbox in test env)
	const execTool = createMeshExecTool(sampleTools, fs, {
		dangerouslyAllowLocalExecution: true,
	});

	it("executes simple code", async () => {
		const result = await execTool.execute({
			code: "console.log('hello world')",
		});

		expect(result).toContain("hello world");
	});

	it("returns values", async () => {
		const result = await execTool.execute({
			code: "return 42",
		});

		expect(result).toContain("42");
	});

	it("calls tools with valid parameters", async () => {
		const result = await execTool.execute({
			code: `
        const user = await createUser({ name: "John", email: "john@example.com" });
        return user;
      `,
		});

		expect(result).toContain("user_123");
		expect(result).toContain("John");
	});

	it("validates tool parameters", async () => {
		const result = await execTool.execute({
			code: `
        await createUser({ name: 123 });
      `,
		});

		expect(result).toContain("error");
	});

	it("handles tools without execute function", async () => {
		const result = await execTool.execute({
			code: `
        await processData({ input: {}, algorithm: "test" });
      `,
		});

		expect(result).toContain("error");
		expect(result).toContain("execute function");
	});

	it("captures console output", async () => {
		const result = await execTool.execute({
			code: `
        console.log("step 1");
        console.log("step 2");
        return "done";
      `,
		});

		expect(result).toContain("step 1");
		expect(result).toContain("step 2");
		expect(result).toContain("done");
	});

	it("handles errors gracefully", async () => {
		const result = await execTool.execute({
			code: `throw new Error("test error")`,
		});

		expect(result).toContain("error");
		expect(result).toContain("test error");
	});

	it("requires sandbox or dangerous flag for execution", async () => {
		const strictExecTool = createMeshExecTool(sampleTools, fs);
		const result = await strictExecTool.execute({
			code: "return 1",
		});

		expect(result).toContain("error");
		expect(result).toContain("dangerouslyAllowLocalExecution");
	});
});

describe("System Prompt Generation", () => {
	const fs = createVirtualFilesystem(sampleTools);

	it("generates full system prompt", () => {
		const prompt = generateSystemPrompt(sampleTools, fs);

		expect(prompt).toContain("Tool Discovery System");
		expect(prompt).toContain("mesh_bash");
		expect(prompt).toContain("mesh_exec");
		expect(prompt).toContain("createUser");
		expect(prompt).toContain("/tools");
	});

	it("includes tool summary by default", () => {
		const prompt = generateSystemPrompt(sampleTools, fs, { includeSummary: true });

		expect(prompt).toContain("Quick Reference");
		expect(prompt).toContain("createUser");
		expect(prompt).toContain("fetchData");
	});

	it("respects custom prefix and suffix", () => {
		const prompt = generateSystemPrompt(sampleTools, fs, {
			prefix: "CUSTOM PREFIX",
			suffix: "CUSTOM SUFFIX",
		});

		expect(prompt).toContain("CUSTOM PREFIX");
		expect(prompt).toContain("CUSTOM SUFFIX");
	});

	it("generates compact prompt", () => {
		const prompt = generateCompactPrompt(sampleTools, fs);

		expect(prompt.length).toBeLessThan(500);
		expect(prompt).toContain("Toolsmesh");
		expect(prompt).toContain("mesh_bash");
		expect(prompt).toContain("mesh_exec");
	});
});

describe("Toolsmesh Creation", () => {
	it("creates toolsmesh with all components", () => {
		const mesh = createToolsmesh({
			tools: sampleTools,
			sandbox: { dangerouslyAllowLocalExecution: true },
		});

		expect(mesh.filesystem).toBeDefined();
		expect(mesh.tools.mesh_bash).toBeDefined();
		expect(mesh.tools.mesh_exec).toBeDefined();
		expect(mesh.systemPrompt).toContain("Tool Discovery");
		expect(mesh.compactPrompt).toContain("Toolsmesh");
	});

	it("creates mesh tools", () => {
		const fs = createVirtualFilesystem(sampleTools);
		const meshTools = createMeshTools(sampleTools, fs, {
			sandbox: { dangerouslyAllowLocalExecution: true },
		});

		expect(meshTools.length).toBe(2);
		expect(meshTools[0].name).toBe("mesh_bash");
		expect(meshTools[1].name).toBe("mesh_exec");
	});
});

describe("Tool Extraction", () => {
	it("extracts tools from AI SDK format", () => {
		const aiSdkTools = {
			myTool: {
				description: "A test tool",
				parameters: z.object({ value: z.string() }),
				execute: async () => "result",
			},
		};

		const registry = extractTools(aiSdkTools);

		expect(registry.myTool).toBeDefined();
		expect(registry.myTool.description).toBe("A test tool");
	});

	it("handles tools without description", () => {
		const aiSdkTools = {
			myTool: {
				parameters: z.object({ value: z.string() }),
			},
		};

		const registry = extractTools(aiSdkTools);

		expect(registry.myTool.description).toContain("Tool: myTool");
	});
});

describe("Compaction", () => {
	const fs = createVirtualFilesystem(sampleTools);

	// Create sample messages with tool results
	const createMessages = (resultSize: number) => {
		const largeResult = "x".repeat(resultSize);
		return [
			{ role: "system" as const, content: "You are a helpful assistant." },
			{ role: "user" as const, content: "Fetch some data" },
			{ role: "assistant" as const, content: "I'll fetch that for you." },
			{
				role: "tool" as const,
				content: [
					{
						type: "tool-result" as const,
						toolCallId: "call_123",
						toolName: "fetchData",
						result: { data: largeResult },
					},
				],
			},
			{ role: "assistant" as const, content: "Here's the data." },
		];
	};

	it("compacts large tool results with write-to-filesystem strategy", () => {
		const messages = createMessages(1000);
		const result = compact(messages, fs, {
			strategy: "write-to-filesystem",
			minSize: 500,
		});

		expect(result.compactedCount).toBe(1);
		expect(result.bytesSaved).toBeGreaterThan(900);
		expect(result.storedPaths.length).toBe(1);
		expect(result.storedPaths[0]).toContain("/tools/compact");

		// Check that file was created in filesystem
		expect(fs.files.has(result.storedPaths[0])).toBe(true);

		// Check the compacted message contains a reference
		const toolMsg = result.messages[3] as { role: "tool"; content: Array<{ result: unknown }> };
		expect(String(toolMsg.content[0].result)).toContain("stored in filesystem");
	});

	it("compacts large tool results with drop-results strategy", () => {
		const messages = createMessages(1000);
		const result = compact(messages, fs, {
			strategy: "drop-results",
			minSize: 500,
		});

		expect(result.compactedCount).toBe(1);
		expect(result.bytesSaved).toBeGreaterThan(900);
		expect(result.storedPaths.length).toBe(0);

		// Check the compacted message contains a dropped placeholder
		const toolMsg = result.messages[3] as { role: "tool"; content: Array<{ result: unknown }> };
		expect(String(toolMsg.content[0].result)).toContain("dropped to preserve context");
	});

	it("does not compact small results", () => {
		const messages = createMessages(100);
		const result = compact(messages, fs, {
			strategy: "write-to-filesystem",
			minSize: 500,
		});

		expect(result.compactedCount).toBe(0);
		expect(result.bytesSaved).toBe(0);
	});

	it("respects keep-first boundary", () => {
		const messages = createMessages(1000);
		const result = compact(messages, fs, {
			strategy: "drop-results",
			boundary: { type: "keep-first", count: 4 },
		});

		// First 4 messages should not be compacted (including the tool result at index 3)
		expect(result.compactedCount).toBe(0);
	});

	it("respects keep-last boundary", () => {
		const messages = createMessages(1000);
		const result = compact(messages, fs, {
			strategy: "drop-results",
			boundary: { type: "keep-last", count: 1 },
		});

		// Last message (index 4) should not be compacted, tool result at index 3 should be
		expect(result.compactedCount).toBe(1);
	});

	it("excludes specified tools from compaction", () => {
		const messages = [
			{
				role: "tool" as const,
				content: [
					{
						type: "tool-result" as const,
						toolCallId: "call_456",
						toolName: "mesh_bash",
						result: "x".repeat(1000),
					},
				],
			},
		];

		const result = compact(messages, fs, {
			strategy: "drop-results",
			excludeTools: ["mesh_bash", "mesh_exec"],
		});

		expect(result.compactedCount).toBe(0);
	});

	it("creates a reusable compactor", () => {
		const compactor = createCompactor(fs, {
			strategy: "drop-results",
			minSize: 500,
		});

		const messages1 = createMessages(1000);
		const result1 = compactor(messages1);
		expect(result1.compactedCount).toBe(1);

		const messages2 = createMessages(100);
		const result2 = compactor(messages2);
		expect(result2.compactedCount).toBe(0);
	});

	it("analyzes potential compaction savings", () => {
		const messages = createMessages(1000);
		const analysis = analyzeCompaction(messages, { minSize: 500 });

		expect(analysis.totalToolResults).toBe(1);
		expect(analysis.compactableResults).toBe(1);
		expect(analysis.estimatedSavings).toBeGreaterThan(900);
		expect(analysis.largestResult?.toolName).toBe("fetchData");
	});
});

describe("Session Cleanup", () => {
	it("cleans up a specific session", () => {
		const fs = createVirtualFilesystem(sampleTools);

		// Create compacted results in session "test-session"
		const messages = [
			{
				role: "tool" as const,
				content: [
					{
						type: "tool-result" as const,
						toolCallId: "call_abc123",
						toolName: "fetchData",
						result: "x".repeat(1000),
					},
				],
			},
		];

		compact(messages, fs, {
			strategy: "write-to-filesystem",
			sessionId: "test-session",
			minSize: 100,
		});

		// Verify file was created
		const sessions = listSessions(fs);
		expect(sessions).toContain("test-session");

		// Cleanup the session
		const result = cleanupSession(fs, "test-session");

		expect(result.deletedCount).toBeGreaterThan(0);
		expect(result.deletedPaths.length).toBeGreaterThan(0);
		expect(result.deletedPaths[0]).toContain("test-session");

		// Verify session is gone
		const sessionsAfter = listSessions(fs);
		expect(sessionsAfter).not.toContain("test-session");
	});

	it("cleans up the default session when no ID provided", () => {
		const fs = createVirtualFilesystem(sampleTools);

		// Create compacted results in default session
		const messages = [
			{
				role: "tool" as const,
				content: [
					{
						type: "tool-result" as const,
						toolCallId: "call_def456",
						toolName: "fetchData",
						result: "x".repeat(1000),
					},
				],
			},
		];

		compact(messages, fs, {
			strategy: "write-to-filesystem",
			// No sessionId - uses "default"
			minSize: 100,
		});

		// Verify default session exists
		const sessions = listSessions(fs);
		expect(sessions).toContain("default");

		// Cleanup without specifying session ID
		const result = cleanupSession(fs);

		expect(result.deletedCount).toBeGreaterThan(0);

		// Verify default session is gone
		const sessionsAfter = listSessions(fs);
		expect(sessionsAfter).not.toContain("default");
	});

	it("cleans up all sessions", () => {
		const fs = createVirtualFilesystem(sampleTools);

		// Create compacted results in multiple sessions
		const messages = [
			{
				role: "tool" as const,
				content: [
					{
						type: "tool-result" as const,
						toolCallId: "call_ghi789",
						toolName: "fetchData",
						result: "x".repeat(1000),
					},
				],
			},
		];

		compact(messages, fs, {
			strategy: "write-to-filesystem",
			sessionId: "session-1",
			minSize: 100,
		});

		compact(messages, fs, {
			strategy: "write-to-filesystem",
			sessionId: "session-2",
			minSize: 100,
		});

		// Verify both sessions exist
		const sessions = listSessions(fs);
		expect(sessions).toContain("session-1");
		expect(sessions).toContain("session-2");

		// Cleanup all sessions
		const result = cleanupAllSessions(fs);

		expect(result.deletedCount).toBeGreaterThan(0);

		// Verify all sessions are gone
		const sessionsAfter = listSessions(fs);
		expect(sessionsAfter).toHaveLength(0);
	});

	it("lists all active sessions", () => {
		const fs = createVirtualFilesystem(sampleTools);

		// Create compacted results in multiple sessions
		const messages = [
			{
				role: "tool" as const,
				content: [
					{
						type: "tool-result" as const,
						toolCallId: "call_list123",
						toolName: "fetchData",
						result: "x".repeat(1000),
					},
				],
			},
		];

		compact(messages, fs, {
			strategy: "write-to-filesystem",
			sessionId: "alpha",
			minSize: 100,
		});

		compact(messages, fs, {
			strategy: "write-to-filesystem",
			sessionId: "beta",
			minSize: 100,
		});

		compact(messages, fs, {
			strategy: "write-to-filesystem",
			sessionId: "gamma",
			minSize: 100,
		});

		const sessions = listSessions(fs);

		expect(sessions).toHaveLength(3);
		expect(sessions).toContain("alpha");
		expect(sessions).toContain("beta");
		expect(sessions).toContain("gamma");
		// Should be sorted
		expect(sessions).toEqual(["alpha", "beta", "gamma"]);
	});

	it("returns empty result when no files to clean", () => {
		const fs = createVirtualFilesystem(sampleTools);

		const result = cleanupSession(fs, "nonexistent-session");

		expect(result.deletedCount).toBe(0);
		expect(result.deletedPaths).toHaveLength(0);
	});
});
