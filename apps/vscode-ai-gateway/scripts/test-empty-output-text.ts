#!/usr/bin/env node
// Test: Does empty output_text cause 400 error?
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

const _API_URL = process.env.OPENRESPONSES_URL || "https://ai-gateway.vercel.sh/v1";
const API_KEY = process.env.OPENRESPONSES_API_KEY || "";
const client = createClient({
	baseUrl: "https://ai-gateway.vercel.sh/v1",
	apiKey: API_KEY!,
});

async function testEmptyOutputText() {
	console.log("Test: Assistant message with empty output_text item");

	const body = {
		model: "anthropic/claude-sonnet-4",
		input: [
			{
				type: "message" as const,
				role: "user" as const,
				content: [{ type: "input_text" as const, text: "Hello" }],
			},
			{
				type: "message" as const,
				role: "assistant" as const,
				content: [
					{ type: "output_text" as const, text: "" }, // EMPTY!
					{ type: "output_text" as const, text: "Hi there!" },
				],
			},
			{
				type: "message" as const,
				role: "user" as const,
				content: [{ type: "input_text" as const, text: "Thanks" }],
			},
		],
	};

	console.log("Request body:", JSON.stringify(body, null, 2));

	try {
		const response = await client.createResponse(body as never);
		console.log("\n--- SUCCESS ---");
		console.log("Response ID:", response.id);
	} catch (error) {
		console.log("\n--- ERROR ---");
		if (error instanceof Error) {
			console.log("Message:", error.message);
			if ("status" in error) console.log("Status:", (error as { status: number }).status);
		} else {
			console.log("Unknown error:", error);
		}
	}
}

async function testNonEmptyOutputText() {
	console.log("\nTest: Assistant message with non-empty output_text items only");

	const body = {
		model: "anthropic/claude-sonnet-4",
		input: [
			{
				type: "message" as const,
				role: "user" as const,
				content: [{ type: "input_text" as const, text: "Hello" }],
			},
			{
				type: "message" as const,
				role: "assistant" as const,
				content: [{ type: "output_text" as const, text: "Hi there!" }],
			},
			{
				type: "message" as const,
				role: "user" as const,
				content: [{ type: "input_text" as const, text: "Thanks" }],
			},
		],
	};

	console.log("Request body:", JSON.stringify(body, null, 2));

	try {
		const response = await client.createResponse(body as never);
		console.log("\n--- SUCCESS ---");
		console.log("Response ID:", response.id);
	} catch (error) {
		console.log("\n--- ERROR ---");
		if (error instanceof Error) {
			console.log("Message:", error.message);
			if ("status" in error) console.log("Status:", (error as { status: number }).status);
		} else {
			console.log("Unknown error:", error);
		}
	}
}

async function testStringContent() {
	console.log("\nTest: Assistant message with string content (not array)");

	const body = {
		model: "anthropic/claude-sonnet-4",
		input: [
			{ type: "message" as const, role: "user" as const, content: "Hello" },
			{
				type: "message" as const,
				role: "assistant" as const,
				content: "Hi there!",
			},
			{ type: "message" as const, role: "user" as const, content: "Thanks" },
		],
	};

	console.log("Request body:", JSON.stringify(body, null, 2));

	try {
		const response = await client.createResponse(body as never);
		console.log("\n--- SUCCESS ---");
		console.log("Response ID:", response.id);
	} catch (error) {
		console.log("\n--- ERROR ---");
		if (error instanceof Error) {
			console.log("Message:", error.message);
			if ("status" in error) console.log("Status:", (error as { status: number }).status);
		} else {
			console.log("Unknown error:", error);
		}
	}
}

async function main() {
	if (!API_KEY) {
		console.error("Set OPENRESPONSES_API_KEY environment variable");
		process.exit(1);
	}

	await testEmptyOutputText();
	await testNonEmptyOutputText();
	await testStringContent();
}

main();
