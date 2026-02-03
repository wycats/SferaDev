/// <reference types="node" />
import * as fs from "node:fs";
import * as path from "node:path";
import { createResponseBodySchema, itemParamSchema } from "openresponses-client/schemas";

const DEFAULT_LOG_PATH = path.resolve(process.cwd(), ".logs", "api-errors.log");

function getLastRequestJson(logText: string): string | null {
	const lines = logText
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	if (lines.length === 0) return null;

	const lastLine = lines[lines.length - 1];
	let entry: unknown;
	try {
		entry = JSON.parse(lastLine);
	} catch {
		return null;
	}

	if (!entry || typeof entry !== "object") return null;
	const request = (entry as { request?: unknown }).request;
	if (!request) return null;

	return JSON.stringify(request);
}

function main(): void {
	const logPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_LOG_PATH;

	if (!fs.existsSync(logPath)) {
		console.error(`Log file not found: ${logPath}`);
		process.exit(1);
	}

	const logText = fs.readFileSync(logPath, "utf8");
	const requestJson = getLastRequestJson(logText);

	if (requestJson === null) {
		console.error("No REQUEST section found in log file.");
		process.exit(1);
	}

	let request: unknown;
	try {
		request = JSON.parse(requestJson);
	} catch (error) {
		console.error("Failed to parse REQUEST JSON.");
		console.error(String(error));
		process.exit(1);
	}

	const requestResult = createResponseBodySchema.safeParse(request);
	if (!requestResult.success) {
		console.error("Request validation failed:");
		console.error(JSON.stringify(requestResult.error.issues, null, 2));
		process.exit(1);
	}

	const input = requestResult.data?.input;
	if (!input || !Array.isArray(input)) {
		console.error("Request input is not an array. Cannot validate items.");
		process.exit(1);
	}

	let invalidItems = 0;
	for (let i = 0; i < input.length; i++) {
		const item = input[i];
		const itemResult = itemParamSchema.safeParse(item);
		if (!itemResult.success) {
			invalidItems += 1;
			console.error(`input[${i}] validation failed:`);
			console.error(JSON.stringify(itemResult.error.issues, null, 2));
		}
	}

	if (invalidItems > 0) {
		console.error(`Validation completed: ${invalidItems} invalid item(s).`);
		process.exit(1);
	}

	console.log("Validation completed: all items valid.");
}

main();
