/**
 * Logging utilities for the Vercel AI Gateway extension.
 *
 * Provides configurable logging with level filtering and VS Code output channel support.
 * Optionally writes to log files when log level is debug/trace and a file directory is configured.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { ConfigService, type LogLevel } from "./config";

export type { LogLevel } from "./config";

export const LOG_LEVELS: Record<LogLevel, number> = {
	off: 0,
	error: 1,
	warn: 2,
	info: 3,
	debug: 4,
	trace: 5,
};

type LoggerConfigSource = Pick<
	ConfigService,
	"logLevel" | "logOutputChannel" | "logFileDirectory" | "onDidChange"
>;

function createFallbackConfigService(): LoggerConfigSource {
	return {
		logLevel: "info",
		logOutputChannel: false,
		logFileDirectory: "",
		onDidChange: () => ({ dispose: () => undefined }),
	};
}

function createConfigServiceSafely(): LoggerConfigSource {
	try {
		return new ConfigService();
	} catch {
		return createFallbackConfigService();
	}
}

function canCreateOutputChannel(): boolean {
	try {
		return typeof vscode.window?.createOutputChannel === "function";
	} catch {
		return false;
	}
}

/**
 * Shared output channel instance.
 *
 * VS Code best practice: Create the output channel ONCE during extension activation
 * and pass it to components via dependency injection. The output channel should be
 * added to context.subscriptions for automatic disposal.
 *
 * This module-level variable is set by initializeOutputChannel() which should be
 * called exactly once from activate().
 */
let _sharedOutputChannel: vscode.OutputChannel | null = null;

/**
 * Initialize the shared output channel.
 * Call this ONCE from extension activate() and add the returned disposable to context.subscriptions.
 *
 * @returns A disposable that cleans up the output channel
 */
export function initializeOutputChannel(): vscode.Disposable {
	if (_sharedOutputChannel) {
		// Already initialized - this shouldn't happen in normal operation
		// but can happen in tests or if activate() is called multiple times
		return { dispose: () => {} };
	}

	try {
		_sharedOutputChannel = vscode.window.createOutputChannel("Vercel AI Gateway");
	} catch {
		// Can't create output channel (e.g., in tests without VS Code context)
		return { dispose: () => {} };
	}

	return {
		dispose: () => {
			_sharedOutputChannel?.dispose();
			_sharedOutputChannel = null;
		},
	};
}

/**
 * Get the shared output channel, if initialized.
 * Returns null if initializeOutputChannel() hasn't been called or if in a test environment.
 */
function getSharedOutputChannel(): vscode.OutputChannel | null {
	return _sharedOutputChannel;
}

/**
 * Reset the shared output channel singleton.
 * Only for testing - allows tests to verify output channel creation.
 * @internal
 */
export function _resetOutputChannelForTesting(): void {
	_sharedOutputChannel?.dispose();
	_sharedOutputChannel = null;
}

export class Logger {
	private outputChannel: vscode.OutputChannel | null = null;
	private level: LogLevel = "info"; // Default to info for better visibility
	private configService: LoggerConfigSource;
	private readonly disposable: { dispose: () => void };
	private logFileDirectory: string = "";
	private fileLoggingInitialized = false;
	private fileLoggingOverridePath: string | undefined;

	constructor(configService?: LoggerConfigSource) {
		this.configService = configService ?? createConfigServiceSafely();
		this.loadConfig();

		this.disposable = this.configService.onDidChange(() => {
			this.loadConfig();
		});
	}

	private loadConfig(): void {
		this.level = this.configService.logLevel ?? "info";
		this.logFileDirectory = this.configService.logFileDirectory ?? "";

		const useOutputChannel = this.configService.logOutputChannel ?? true;
		const canUseOutputChannel = canCreateOutputChannel();
		if (useOutputChannel && canUseOutputChannel && !this.outputChannel) {
			// Use the shared output channel initialized during extension activation
			this.outputChannel = getSharedOutputChannel();
		} else if (!useOutputChannel && this.outputChannel) {
			// Don't dispose the shared channel - just stop using it
			this.outputChannel = null;
		}

		// Initialize file logging directory if configured and level is debug/trace
		if (this.shouldUseFileLogging() && !this.fileLoggingInitialized) {
			this.initializeFileLogging();
		}
	}

	private shouldUseFileLogging(): boolean {
		return this.logFileDirectory !== "" && (this.level === "debug" || this.level === "trace");
	}

	private getResolvedLogDirectory(): string | null {
		if (!this.logFileDirectory) return null;

		// If absolute path, use as-is
		if (path.isAbsolute(this.logFileDirectory)) {
			return this.logFileDirectory;
		}

		// Relative path: resolve against workspace root
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders && workspaceFolders.length > 0) {
			return path.join(workspaceFolders[0].uri.fsPath, this.logFileDirectory);
		}

		return null;
	}

	private initializeFileLogging(): void {
		const logDir = this.getResolvedLogDirectory();
		if (!logDir) return;

		try {
			// Create directory if it doesn't exist
			if (!fs.existsSync(logDir)) {
				fs.mkdirSync(logDir, { recursive: true });
			}

			// Rotate previous.log <- current.log
			const currentLogPath = path.join(logDir, "current.log");
			const previousLogPath = path.join(logDir, "previous.log");

			if (fs.existsSync(currentLogPath)) {
				// Move current to previous (overwrite previous)
				fs.renameSync(currentLogPath, previousLogPath);
			}

			// Write session start marker
			const sessionStart = `\n${"=".repeat(80)}\nSession started: ${new Date().toISOString()}\n${"=".repeat(80)}\n\n`;
			fs.writeFileSync(currentLogPath, sessionStart);

			this.fileLoggingInitialized = true;
		} catch {
			// Silently fail - file logging is optional
			this.fileLoggingInitialized = false;
		}
	}

	private writeToFile(level: LogLevel, formatted: string): void {
		if (!this.shouldUseFileLogging()) return;

		const logDir = this.getResolvedLogDirectory();
		if (!logDir) return;

		try {
			// Use override path if set (per-chat logging), otherwise default to current.log
			const fileName = this.fileLoggingOverridePath || "current.log";
			const currentLogPath = path.join(logDir, fileName);
			fs.appendFileSync(currentLogPath, `${formatted}\n`);

			// Also write errors to errors.log for quick access
			if (level === "error") {
				const errorsLogPath = path.join(logDir, "errors.log");
				fs.appendFileSync(errorsLogPath, `${formatted}\n`);
			}
		} catch {
			// Silently fail - don't let file logging errors break the extension
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
			case "trace":
				console.debug(formatted, ...args);
				break;
		}

		const argsStr = args.length > 0 ? ` ${JSON.stringify(args)}` : "";
		const fullFormatted = formatted + argsStr;

		if (this.outputChannel) {
			this.outputChannel.appendLine(fullFormatted);
		}

		// Write to file if file logging is enabled
		this.writeToFile(level, fullFormatted);
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

	trace(message: string, ...args: unknown[]): void {
		this.log("trace", message, ...args);
	}

	show(): void {
		this.outputChannel?.show();
	}

	dispose(): void {
		this.disposable.dispose();
		// Don't dispose the shared output channel here - it's managed by context.subscriptions
		// via initializeOutputChannel(). Just clear our reference.
		this.outputChannel = null;
	}

	/**
	 * Create a per-chat logger for debugging individual conversations.
	 * Useful for diagnosing issues in specific chats.
	 */
	createChatLogger(chatId: string): Logger {
		const chatLogger = new Logger(this.configService);
		// Set the same directory but override the file path to per-chat log
		chatLogger.logFileDirectory = this.logFileDirectory;
		chatLogger.setFileLoggingPath(`${chatId}.log`);
		return chatLogger;
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
	trace(message: string, ...args: unknown[]): void {
		getLogger().trace(message, ...args);
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
	logger.error(`${context}:`, error);

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
			logger.error(`${context} - Details:`, details);
		}

		// Log stack trace if available
		if (error instanceof Error && error.stack) {
			logger.debug(`${context} - Stack:`, error.stack);
		}
	}
}

/**
 * Clean up error messages that have malformed prefixes like "undefined: ".
 */
function cleanErrorMessage(message: string): string {
	// Remove "undefined: " prefix that can come from some providers (e.g., AWS Bedrock)
	return message.replace(/^undefined:\s*/i, "");
}

/**
 * Extract a user-friendly error message from various error types.
 *
 * For Vercel AI Gateway errors, attempts to find the most informative error
 * from provider routing attempts (e.g., Anthropic's "prompt is too long: X tokens > Y maximum").
 */
export function extractErrorMessage(error: unknown): string {
	if (error && typeof error === "object") {
		const errorObj = error as Record<string, unknown>;

		// Try to extract message from response body (often contains more detail)
		if ("responseBody" in errorObj && typeof errorObj.responseBody === "string") {
			try {
				const parsed = JSON.parse(errorObj.responseBody);

				// Try to find the best error from routing attempts
				// Prefer the first error with specific details over generic ones
				const attempts = parsed.providerMetadata?.gateway?.routing?.attempts;
				if (Array.isArray(attempts)) {
					for (const attempt of attempts) {
						if (attempt.error && typeof attempt.error === "string") {
							const cleaned = cleanErrorMessage(attempt.error);
							// Prefer more informative errors (e.g., with token counts)
							if (
								cleaned.includes("tokens") ||
								cleaned.includes("too long") ||
								cleaned.includes("exceeds")
							) {
								return cleaned;
							}
						}
					}
					// Fall back to first attempt's error if no informative one found
					const firstError = attempts[0]?.error;
					if (firstError && typeof firstError === "string") {
						return cleanErrorMessage(firstError);
					}
				}

				// Fall back to top-level error message
				if (parsed.error?.message) {
					return cleanErrorMessage(parsed.error.message);
				}
			} catch {
				// Fall through to other extraction methods
			}
		}

		// Use error message if available
		if ("message" in errorObj && typeof errorObj.message === "string") {
			return cleanErrorMessage(errorObj.message);
		}
	}

	if (error instanceof Error) {
		return cleanErrorMessage(error.message);
	}

	if (typeof error === "string") {
		return cleanErrorMessage(error);
	}

	return "An unexpected error occurred";
}

/**
 * Token count information extracted from an error message.
 */
export interface ExtractedTokenInfo {
	/** The actual number of input tokens that caused the error */
	actualTokens: number;
	/** The maximum allowed tokens (if parseable) */
	maxTokens?: number;
}

/**
 * Extract actual token count from "input too long" error messages.
 *
 * Parses errors like:
 * - "prompt is too long: 204716 tokens > 200000 maximum"
 * - "Input is too long for requested model."
 *
 * Returns the actual token count if parseable, undefined otherwise.
 */
export function extractTokenCountFromError(error: unknown): ExtractedTokenInfo | undefined {
	// First, get the error message using existing extraction logic
	const message = extractErrorMessage(error);

	// Pattern: "prompt is too long: 204716 tokens > 200000 maximum"
	const tokenPattern = /(\d+)\s*tokens?\s*>\s*(\d+)/i;
	const match = message.match(tokenPattern);

	if (match) {
		const actualTokens = parseInt(match[1], 10);
		const maxTokens = parseInt(match[2], 10);
		if (!Number.isNaN(actualTokens) && actualTokens > 0) {
			return {
				actualTokens,
				maxTokens: !Number.isNaN(maxTokens) ? maxTokens : undefined,
			};
		}
	}

	// Pattern: "exceeds context window of X tokens" or similar
	const exceedsPattern = /exceeds.*?(\d+)\s*tokens?/i;
	const exceedsMatch = message.match(exceedsPattern);
	if (exceedsMatch) {
		const maxTokens = parseInt(exceedsMatch[1], 10);
		// We don't know the actual count, but we know the max
		if (!Number.isNaN(maxTokens)) {
			return { actualTokens: maxTokens + 1, maxTokens };
		}
	}

	return undefined;
}
