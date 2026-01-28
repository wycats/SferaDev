import { beforeEach, describe, expect, it, vi } from "vitest";

// Create hoisted mock functions
const hoisted = vi.hoisted(() => {
	const mockEventEmitterFire = vi.fn();
	const mockEventEmitterDispose = vi.fn();
	const mockEventEmitterEvent = vi.fn();
	const listeners: Array<() => void> = [];

	class MockEventEmitter {
		event = (listener: () => void) => {
			listeners.push(listener);
			mockEventEmitterEvent(listener);
			return { dispose: vi.fn() };
		};
		fire = () => {
			mockEventEmitterFire();
			for (const listener of listeners) {
				listener();
			}
		};
		dispose = mockEventEmitterDispose;
	}

	const mockOutputChannelAppendLine = vi.fn();
	const mockOutputChannelShow = vi.fn();
	const mockOutputChannelDispose = vi.fn();
	const mockCreateOutputChannel = vi.fn(() => ({
		appendLine: mockOutputChannelAppendLine,
		show: mockOutputChannelShow,
		dispose: mockOutputChannelDispose,
	}));
	const mockGetConfiguration = vi.fn();
	const mockOnDidChangeConfiguration = vi.fn(
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		(_callback?: unknown) => ({ dispose: vi.fn() }),
	);

	return {
		mockEventEmitterFire,
		mockEventEmitterDispose,
		mockEventEmitterEvent,
		MockEventEmitter,
		mockOutputChannelAppendLine,
		mockOutputChannelShow,
		mockOutputChannelDispose,
		mockCreateOutputChannel,
		mockGetConfiguration,
		mockOnDidChangeConfiguration,
	};
});

// Mock vscode module
vi.mock("vscode", () => ({
	EventEmitter: hoisted.MockEventEmitter,
	window: {
		createOutputChannel: hoisted.mockCreateOutputChannel,
	},
	workspace: {
		getConfiguration: hoisted.mockGetConfiguration,
		onDidChangeConfiguration: hoisted.mockOnDidChangeConfiguration,
	},
}));

// Import after mocking
import { LOG_LEVELS, Logger, type LogLevel } from "./logger";

describe("Logger", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default configuration
		hoisted.mockGetConfiguration.mockReturnValue({
			get: vi.fn((key: string, defaultValue: unknown) => {
				if (key === "logging.level") return "warn";
				if (key === "logging.outputChannel") return true;
				return defaultValue;
			}),
		});
	});

	describe("LOG_LEVELS", () => {
		it("should define correct priority order", () => {
			expect(LOG_LEVELS.off).toBe(0);
			expect(LOG_LEVELS.error).toBe(1);
			expect(LOG_LEVELS.warn).toBe(2);
			expect(LOG_LEVELS.info).toBe(3);
			expect(LOG_LEVELS.debug).toBe(4);
		});

		it("should have higher values for more verbose levels", () => {
			expect(LOG_LEVELS.debug).toBeGreaterThan(LOG_LEVELS.info);
			expect(LOG_LEVELS.info).toBeGreaterThan(LOG_LEVELS.warn);
			expect(LOG_LEVELS.warn).toBeGreaterThan(LOG_LEVELS.error);
			expect(LOG_LEVELS.error).toBeGreaterThan(LOG_LEVELS.off);
		});
	});

	describe("constructor", () => {
		it("should load configuration on creation", () => {
			new Logger();
			expect(hoisted.mockGetConfiguration).toHaveBeenCalledWith("vercelAiGateway");
		});

		it("should create output channel when enabled", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string) => {
					if (key === "logging.level") return "warn";
					if (key === "logging.outputChannel") return true;
					return undefined;
				}),
			});

			new Logger();
			expect(hoisted.mockCreateOutputChannel).toHaveBeenCalledWith("Vercel AI Gateway");
		});

		it("should not create output channel when disabled", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string) => {
					if (key === "logging.level") return "warn";
					if (key === "logging.outputChannel") return false;
					return undefined;
				}),
			});

			new Logger();
			expect(hoisted.mockCreateOutputChannel).not.toHaveBeenCalled();
		});

		it("should register configuration change listener", () => {
			new Logger();
			expect(hoisted.mockOnDidChangeConfiguration).toHaveBeenCalled();
		});
	});

	describe("level filtering", () => {
		it("should log error when level is error", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string) => {
					if (key === "logging.level") return "error";
					if (key === "logging.outputChannel") return true;
					return undefined;
				}),
			});

			const logger = new Logger();
			const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			logger.error("test error");
			expect(consoleSpy).toHaveBeenCalled();
			consoleSpy.mockRestore();
		});

		it("should not log warn when level is error", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string) => {
					if (key === "logging.level") return "error";
					if (key === "logging.outputChannel") return false;
					return undefined;
				}),
			});

			const logger = new Logger();
			const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			logger.warn("test warn");
			expect(consoleSpy).not.toHaveBeenCalled();
			consoleSpy.mockRestore();
		});

		it("should log both error and warn when level is warn", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string) => {
					if (key === "logging.level") return "warn";
					if (key === "logging.outputChannel") return false;
					return undefined;
				}),
			});

			const logger = new Logger();
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			logger.error("test error");
			logger.warn("test warn");

			expect(errorSpy).toHaveBeenCalled();
			expect(warnSpy).toHaveBeenCalled();

			errorSpy.mockRestore();
			warnSpy.mockRestore();
		});

		it("should not log info when level is warn", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string) => {
					if (key === "logging.level") return "warn";
					if (key === "logging.outputChannel") return false;
					return undefined;
				}),
			});

			const logger = new Logger();
			const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

			logger.info("test info");
			expect(infoSpy).not.toHaveBeenCalled();
			infoSpy.mockRestore();
		});

		it("should log all levels when level is debug", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string) => {
					if (key === "logging.level") return "debug";
					if (key === "logging.outputChannel") return false;
					return undefined;
				}),
			});

			const logger = new Logger();
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
			const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

			logger.error("test error");
			logger.warn("test warn");
			logger.info("test info");
			logger.debug("test debug");

			expect(errorSpy).toHaveBeenCalled();
			expect(warnSpy).toHaveBeenCalled();
			expect(infoSpy).toHaveBeenCalled();
			expect(debugSpy).toHaveBeenCalled();

			errorSpy.mockRestore();
			warnSpy.mockRestore();
			infoSpy.mockRestore();
			debugSpy.mockRestore();
		});

		it("should not log anything when level is off", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string) => {
					if (key === "logging.level") return "off";
					if (key === "logging.outputChannel") return false;
					return undefined;
				}),
			});

			const logger = new Logger();
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
			const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

			logger.error("test error");
			logger.warn("test warn");
			logger.info("test info");
			logger.debug("test debug");

			expect(errorSpy).not.toHaveBeenCalled();
			expect(warnSpy).not.toHaveBeenCalled();
			expect(infoSpy).not.toHaveBeenCalled();
			expect(debugSpy).not.toHaveBeenCalled();

			errorSpy.mockRestore();
			warnSpy.mockRestore();
			infoSpy.mockRestore();
			debugSpy.mockRestore();
		});
	});

	describe("output channel", () => {
		it("should write to output channel when enabled", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string) => {
					if (key === "logging.level") return "debug";
					if (key === "logging.outputChannel") return true;
					return undefined;
				}),
			});

			const logger = new Logger();
			vi.spyOn(console, "debug").mockImplementation(() => {});

			logger.debug("test message");
			expect(hoisted.mockOutputChannelAppendLine).toHaveBeenCalled();
		});

		it("should include timestamp and level in output", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string) => {
					if (key === "logging.level") return "info";
					if (key === "logging.outputChannel") return true;
					return undefined;
				}),
			});

			const logger = new Logger();
			vi.spyOn(console, "info").mockImplementation(() => {});

			logger.info("test message");

			const call = hoisted.mockOutputChannelAppendLine.mock.calls[0][0];
			expect(call).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // ISO timestamp
			expect(call).toMatch(/\[INFO\]/);
			expect(call).toContain("test message");
		});

		it("should include additional args in output", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string) => {
					if (key === "logging.level") return "info";
					if (key === "logging.outputChannel") return true;
					return undefined;
				}),
			});

			const logger = new Logger();
			vi.spyOn(console, "info").mockImplementation(() => {});

			logger.info("test message", { key: "value" });

			const call = hoisted.mockOutputChannelAppendLine.mock.calls[0][0];
			expect(call).toContain("key");
			expect(call).toContain("value");
		});
	});

	describe("show()", () => {
		it("should show output channel when called", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string) => {
					if (key === "logging.level") return "warn";
					if (key === "logging.outputChannel") return true;
					return undefined;
				}),
			});

			const logger = new Logger();
			logger.show();

			expect(hoisted.mockOutputChannelShow).toHaveBeenCalled();
		});

		it("should not throw when output channel is disabled", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string) => {
					if (key === "logging.level") return "warn";
					if (key === "logging.outputChannel") return false;
					return undefined;
				}),
			});

			const logger = new Logger();
			expect(() => logger.show()).not.toThrow();
		});
	});

	describe("dispose()", () => {
		it("should dispose output channel when called", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string) => {
					if (key === "logging.level") return "warn";
					if (key === "logging.outputChannel") return true;
					return undefined;
				}),
			});

			const logger = new Logger();
			logger.dispose();

			expect(hoisted.mockOutputChannelDispose).toHaveBeenCalled();
		});

		it("should not throw when output channel is disabled", () => {
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string) => {
					if (key === "logging.level") return "warn";
					if (key === "logging.outputChannel") return false;
					return undefined;
				}),
			});

			const logger = new Logger();
			expect(() => logger.dispose()).not.toThrow();
		});
	});

	describe("configuration change handling", () => {
		it("should update level when configuration changes", () => {
			let configChangeCallback:
				| ((e: { affectsConfiguration: (s: string) => boolean }) => void)
				| undefined;

			(hoisted.mockOnDidChangeConfiguration.mockImplementation as (fn: unknown) => void)(
				(callback: (e: { affectsConfiguration: (s: string) => boolean }) => void) => {
					configChangeCallback = callback;
					return { dispose: vi.fn() };
				},
			);

			// Start with warn level
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string) => {
					if (key === "logging.level") return "warn";
					if (key === "logging.outputChannel") return false;
					return undefined;
				}),
			});

			const logger = new Logger();
			const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

			// Info should not log at warn level
			logger.info("test");
			expect(infoSpy).not.toHaveBeenCalled();

			// Change to debug level
			hoisted.mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string) => {
					if (key === "logging.level") return "debug";
					if (key === "logging.outputChannel") return false;
					return undefined;
				}),
			});

			// Trigger configuration change
			configChangeCallback?.({
				affectsConfiguration: (s: string) => s === "vercelAiGateway",
			});

			// Now info should log
			logger.info("test");
			expect(infoSpy).toHaveBeenCalled();

			infoSpy.mockRestore();
		});
	});
});
