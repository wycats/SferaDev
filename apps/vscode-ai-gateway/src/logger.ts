/**
 * Logging utilities for the Vercel AI Gateway extension.
 *
 * Provides configurable logging with level filtering and VS Code output channel support.
 */

import * as vscode from "vscode";
import { ConfigService, type LogLevel } from "./config";

export type { LogLevel } from "./config";

export const LOG_LEVELS: Record<LogLevel, number> = {
	off: 0,
	error: 1,
	warn: 2,
	info: 3,
	debug: 4,
};

export class Logger {
	private outputChannel: vscode.OutputChannel | null = null;
	private level: LogLevel = "info"; // Default to info for better visibility
	private configService: ConfigService;
	private readonly disposable: { dispose: () => void };

	constructor(configService: ConfigService = new ConfigService()) {
		this.configService = configService;
		this.loadConfig();

		this.disposable = this.configService.onDidChange(() => {
			this.loadConfig();
		});
	}

	private loadConfig(): void {
		this.level = this.configService.logLevel ?? "info";

		const useOutputChannel = this.configService.logOutputChannel ?? true;
		if (useOutputChannel && !this.outputChannel) {
			this.outputChannel = vscode.window.createOutputChannel("Vercel AI Gateway");
		} else if (!useOutputChannel && this.outputChannel) {
			this.outputChannel.dispose();
			this.outputChannel = null;
		}
	}

	private shouldLog(level: LogLevel): boolean {
		return LOG_LEVELS[level] <= LOG_LEVELS[this.level];
	}

	private log(level: LogLevel, message: string, ...args: unknown[]): void {
		if (!this.shouldLog(level)) return;

		const timestamp = new Date().toISOString();
		const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
		const formatted = `${prefix} ${message}`;

		switch (level) {
			case "error":
				console.error(formatted, ...args);
				break;
			case "warn":
				console.warn(formatted, ...args);
				break;
			case "info":
				console.info(formatted, ...args);
				break;
			case "debug":
				console.debug(formatted, ...args);
				break;
		}

		if (this.outputChannel) {
			const argsStr = args.length > 0 ? " " + JSON.stringify(args) : "";
			this.outputChannel.appendLine(formatted + argsStr);
		}
	}

	error(message: string, ...args: unknown[]): void {
		this.log("error", message, ...args);
	}

	warn(message: string, ...args: unknown[]): void {
		this.log("warn", message, ...args);
	}

	info(message: string, ...args: unknown[]): void {
		this.log("info", message, ...args);
	}

	debug(message: string, ...args: unknown[]): void {
		this.log("debug", message, ...args);
	}

	show(): void {
		this.outputChannel?.show();
	}

	dispose(): void {
		this.disposable.dispose();
		this.outputChannel?.dispose();
	}
}

// Lazy singleton logger instance
let _logger: Logger | null = null;

export function getLogger(): Logger {
	if (!_logger) {
		_logger = new Logger();
	}
	return _logger;
}

// For backward compatibility - getter that lazily initializes
export const logger = {
	get instance(): Logger {
		return getLogger();
	},
	error(message: string, ...args: unknown[]): void {
		getLogger().error(message, ...args);
	},
	warn(message: string, ...args: unknown[]): void {
		getLogger().warn(message, ...args);
	},
	info(message: string, ...args: unknown[]): void {
		getLogger().info(message, ...args);
	},
	debug(message: string, ...args: unknown[]): void {
		getLogger().debug(message, ...args);
	},
	show(): void {
		getLogger().show();
	},
	dispose(): void {
		getLogger().dispose();
		_logger = null;
	},
};

/**
 * Log detailed error information for debugging.
 *
 * Extracts full context from AI SDK error types including:
 * - GatewayError: API response details, status codes, request info
 * - APICallError: Provider-specific error details
 * - Standard Error: Stack trace and message
 */
export function logError(context: string, error: unknown): void {
	console.error(`[VercelAI] ${context}:`, error);

	if (error && typeof error === "object") {
		const errorObj = error as Record<string, unknown>;

		// Log structured error details if available
		const details: Record<string, unknown> = {};

		if ("name" in errorObj) details.name = errorObj.name;
		if ("message" in errorObj) details.message = errorObj.message;
		if ("statusCode" in errorObj) details.statusCode = errorObj.statusCode;
		if ("status" in errorObj) details.status = errorObj.status;
		if ("responseBody" in errorObj) details.responseBody = errorObj.responseBody;
		if ("url" in errorObj) details.url = errorObj.url;
		if ("requestBodyValues" in errorObj) details.requestBodyValues = errorObj.requestBodyValues;
		if ("cause" in errorObj) details.cause = errorObj.cause;
		if ("data" in errorObj) details.data = errorObj.data;
		if ("generationId" in errorObj) details.generationId = errorObj.generationId;

		if (Object.keys(details).length > 0) {
			console.error(`[VercelAI] ${context} - Details:`, details);
		}

		// Log stack trace if available
		if (error instanceof Error && error.stack) {
			console.debug(`[VercelAI] ${context} - Stack:`, error.stack);
		}
	}
}

/**
 * Extract a user-friendly error message from various error types.
 */
export function extractErrorMessage(error: unknown): string {
	if (error && typeof error === "object") {
		const errorObj = error as Record<string, unknown>;

		// Try to extract message from response body (often contains more detail)
		if ("responseBody" in errorObj && typeof errorObj.responseBody === "string") {
			try {
				const parsed = JSON.parse(errorObj.responseBody);
				if (parsed.error?.message) {
					return parsed.error.message;
				}
			} catch {
				// Fall through to other extraction methods
			}
		}

		// Use error message if available
		if ("message" in errorObj && typeof errorObj.message === "string") {
			return errorObj.message;
		}
	}

	if (error instanceof Error) {
		return error.message;
	}

	if (typeof error === "string") {
		return error;
	}

	return "An unexpected error occurred";
}
