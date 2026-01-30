#!/usr/bin/env node
/**
 * CLI tool to test OpenResponses API payloads directly.
 * Uses the configured API key from .env or environment.
 *
 * Usage:
 *   node scripts/test-openresponses.ts minimal
 *   node scripts/test-openresponses.ts system-first
 *   node scripts/test-openresponses.ts developer-first
 *   node scripts/test-openresponses.ts replay
 *   node scripts/test-openresponses.ts custom '{"model":"...","input":[...]}'
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "openresponses-client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file if it exists
const envPath = path.resolve(__dirname, "../.env");
if (fs.existsSync(envPath)) {
	const envContent = fs.readFileSync(envPath, "utf8");
	for (const line of envContent.split("\n")) {
		const trimmed = line.trim();
		if (trimmed && !trimmed.startsWith("#")) {
			const eqIndex = trimmed.indexOf("=");
			if (eqIndex > 0) {
				const key = trimmed.slice(0, eqIndex).trim();
				let value = trimmed.slice(eqIndex + 1).trim();
				// Remove quotes if present
				if (
					(value.startsWith('"') && value.endsWith('"')) ||
					(value.startsWith("'") && value.endsWith("'"))
				) {
					value = value.slice(1, -1);
				}
				if (!process.env[key]) {
					process.env[key] = value;
				}
			}
		}
	}
}

const LOG_PATH = path.resolve(__dirname, "../../../.logs/api-errors.log");

// Default config - override with env vars or .env
const API_URL = process.env.OPENRESPONSES_URL || "https://ai-gateway.vercel.sh/v1";
const API_KEY = process.env.OPENRESPONSES_API_KEY || "";
const MODEL = process.env.OPENRESPONSES_MODEL || "anthropic/claude-sonnet-4";

interface TestPayload {
	name: string;
	body: Record<string, unknown>;
}

// Test payloads
const PAYLOADS: Record<string, TestPayload> = {
	minimal: {
		name: "Minimal user message",
		body: {
			model: MODEL,
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Say hello" }],
				},
			],
		},
	},

	"system-first": {
		name: "System message first (role: system)",
		body: {
			model: MODEL,
			input: [
				{
					type: "message",
					role: "system",
					content: [{ type: "input_text", text: "You are a helpful assistant." }],
				},
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Say hello" }],
				},
			],
		},
	},

	"developer-first": {
		name: "Developer message first (role: developer)",
		body: {
			model: MODEL,
			input: [
				{
					type: "message",
					role: "developer",
					content: [{ type: "input_text", text: "You are a helpful assistant." }],
				},
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Say hello" }],
				},
			],
		},
	},

	instructions: {
		name: "Using instructions field instead of system message",
		body: {
			model: MODEL,
			instructions: "You are a helpful assistant.",
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Say hello" }],
				},
			],
		},
	},

	"with-tool": {
		name: "With a simple tool",
		body: {
			model: MODEL,
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "What time is it?" }],
				},
			],
			tools: [
				{
					type: "function",
					name: "get_time",
					description: "Get the current time",
					parameters: { type: "object", properties: {} },
				},
			],
			tool_choice: "auto",
		},
	},

	"tool-call-result": {
		name: "With tool call and result in history (BROKEN - uses invalid function_call input)",
		body: {
			model: MODEL,
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "What time is it?" }],
				},
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "Let me check the time." }],
				},
				{
					type: "function_call",
					call_id: "call_123",
					name: "get_time",
					arguments: "{}",
				},
				{
					type: "function_call_output",
					call_id: "call_123",
					output: "The current time is 3:00 PM",
				},
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Thanks!" }],
				},
			],
			tools: [
				{
					type: "function",
					name: "get_time",
					description: "Get the current time",
					parameters: { type: "object", properties: {} },
				},
			],
			tool_choice: "auto",
		},
	},

	"tool-embedded": {
		name: "Tool call/result embedded in message text (CORRECT workaround)",
		body: {
			model: MODEL,
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "What time is it?" }],
				},
				{
					type: "message",
					role: "assistant",
					content:
						"Let me check the time.\n\n<!-- prior-tool: get_time | id: call_123 | args: {} -->",
				},
				{
					type: "message",
					role: "user",
					content: [
						{
							type: "input_text",
							text: "<!-- prior-tool-result: call_123 -->\nThe current time is 3:00 PM",
						},
					],
				},
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Thanks!" }],
				},
			],
			tools: [
				{
					type: "function",
					name: "get_time",
					description: "Get the current time",
					parameters: { type: "object", properties: {} },
				},
			],
			tool_choice: "auto",
		},
	},

	"string-content": {
		name: "String content instead of array",
		body: {
			model: MODEL,
			input: [
				{
					type: "message",
					role: "user",
					content: "Say hello",
				},
			],
		},
	},

	"user-only-string": {
		name: "Just a string input (not array)",
		body: {
			model: MODEL,
			input: "Say hello",
		},
	},
};

function getLastLoggedRequest(): Record<string, unknown> | null {
	if (!fs.existsSync(LOG_PATH)) {
		console.error("No log file found at", LOG_PATH);
		return null;
	}
	const lines = fs.readFileSync(LOG_PATH, "utf8").trim().split("\n").filter(Boolean);
	if (lines.length === 0) return null;
	const entry = JSON.parse(lines[lines.length - 1]);
	return entry.request;
}

async function sendRequest(body: Record<string, unknown>): Promise<void> {
	if (!API_KEY) {
		console.error("ERROR: No API key configured.");
		console.error("Set OPENRESPONSES_API_KEY environment variable.");
		process.exit(1);
	}

	console.log("\n--- Request ---");
	console.log("URL:", API_URL);
	console.log("Model:", body.model);
	console.log("Input items:", Array.isArray(body.input) ? body.input.length : "string");
	console.log("Tools:", Array.isArray(body.tools) ? body.tools.length : 0);
	console.log("Has instructions:", !!body.instructions);
	console.log("\nFull body:");
	console.log(JSON.stringify(body, null, 2).substring(0, 2000));
	if (JSON.stringify(body).length > 2000) {
		console.log("... (truncated)");
	}

	const client = createClient({
		baseUrl: API_URL,
		apiKey: API_KEY,
	});

	console.log("\n--- Sending request ---");

	try {
		// Use non-streaming for simplicity
		const response = await client.createResponse(body as never);
		console.log("\n--- Success! ---");
		console.log("Response ID:", response.id);
		console.log("Model:", response.model);
		console.log("Output:", JSON.stringify(response.output, null, 2).substring(0, 500));
	} catch (error) {
		console.log("\n--- Error ---");
		if (error instanceof Error) {
			console.log("Message:", error.message);
			if ("status" in error) console.log("Status:", (error as { status: number }).status);
			if ("details" in error)
				console.log("Details:", JSON.stringify((error as { details: unknown }).details, null, 2));
		} else {
			console.log("Unknown error:", error);
		}
	}
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
	const command = process.argv[2] || "help";
	const arg = process.argv[3];

	if (command === "help" || command === "--help") {
		console.log("OpenResponses API Test CLI");
		console.log("\nUsage:");
		console.log("  node scripts/test-openresponses.ts <command> [args]");
		console.log("\nCommands:");
		console.log("  list                    - List available test payloads");
		console.log("  <payload-name>          - Send a named test payload");
		console.log("  replay                  - Replay the last logged failing request");
		console.log("  replay-minimal          - Replay with minimal items from last request");
		console.log("  -                       - Read JSON payload from stdin");
		console.log("  custom '<json>'         - Send a custom JSON payload");
		console.log("\nEnvironment (or .env file):");
		console.log("  OPENRESPONSES_API_KEY   - API key (required)");
		console.log("  OPENRESPONSES_URL       - API URL (default: https://ai-gateway.vercel.sh/v1)");
		console.log("  OPENRESPONSES_MODEL     - Model (default: anthropic/claude-sonnet-4)");
		console.log("\nExamples:");
		console.log("  node scripts/test-openresponses.ts minimal");
		console.log('  echo \'{"model":"...","input":[...]}\' | node scripts/test-openresponses.ts -');
		console.log("  cat payload.json | node scripts/test-openresponses.ts -");
		return;
	}

	if (command === "list") {
		console.log("Available test payloads:");
		for (const [key, payload] of Object.entries(PAYLOADS)) {
			console.log(`  ${key.padEnd(20)} - ${payload.name}`);
		}
		return;
	}

	if (command === "-") {
		// Read from stdin
		const input = await readStdin();
		const body = JSON.parse(input.trim());
		await sendRequest(body);
		return;
	}

	if (command === "replay") {
		const request = getLastLoggedRequest();
		if (!request) {
			console.error("No logged request found");
			process.exit(1);
		}
		await sendRequest(request);
		return;
	}

	if (command === "replay-minimal") {
		const request = getLastLoggedRequest();
		if (!request) {
			console.error("No logged request found");
			process.exit(1);
		}
		// Take just first 5 input items
		const minimal = {
			...request,
			input: Array.isArray(request.input) ? request.input.slice(0, 5) : request.input,
			tools: Array.isArray(request.tools) ? request.tools.slice(0, 3) : request.tools,
		};
		await sendRequest(minimal);
		return;
	}

	if (command === "custom") {
		if (!arg) {
			console.error("Usage: test-openresponses.ts custom '<json>'");
			process.exit(1);
		}
		const body = JSON.parse(arg);
		await sendRequest(body);
		return;
	}

	// Named payload
	const payload = PAYLOADS[command];
	if (!payload) {
		console.error(`Unknown command or payload: ${command}`);
		console.error("Run with 'list' to see available payloads, or use '-' to read from stdin");
		process.exit(1);
	}

	console.log(`Testing: ${payload.name}`);
	await sendRequest(payload.body);
}

main().catch(console.error);
