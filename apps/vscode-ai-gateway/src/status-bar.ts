import * as vscode from "vscode";
import { logger } from "./logger";

/**
 * Token usage data from a completed request
 */
export interface ContextManagementEdit {
	type: "clear_tool_uses_20250919" | "clear_thinking_20251015";
	clearedInputTokens: number;
	clearedToolUses?: number;
	clearedThinkingTurns?: number;
}

export interface ContextManagementInfo {
	appliedEdits: ContextManagementEdit[];
}

export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	maxInputTokens?: number;
	modelId?: string;
	contextManagement?: ContextManagementInfo;
}

/**
 * Session entry tracking token usage across related requests (main + subagents)
 */
export interface SessionEntry {
	id: string;
	startTime: number;
	lastUpdateTime: number;
	inputTokens: number;
	outputTokens: number;
	maxInputTokens?: number;
	modelId?: string;
	requestCount: number;
	status: "streaming" | "complete" | "error";
	contextManagement?: ContextManagementInfo;
	/** Whether this session has been dimmed due to inactivity */
	dimmed: boolean;
}

/** Session aging configuration */
const SESSION_DIM_AFTER_MS = 30_000; // Dim after 30 seconds of inactivity
const SESSION_REMOVE_AFTER_MS = 120_000; // Remove after 2 minutes of inactivity
const SESSION_REMOVE_AFTER_REQUESTS = 5; // Remove old sessions when we have this many new ones
const SESSION_CLEANUP_INTERVAL_MS = 5_000; // Check for stale sessions every 5 seconds

/**
 * Status bar item that displays token usage information with session tracking.
 *
 * Shows:
 * - During request: "$(loading~spin) ~50k/128k (39%) streaming..."
 * - After completion: "$(symbol-number) 52k/128k (1.2k out)"
 * - With compaction: "$(fold) 52k/128k (1.2k out) ↓15k"
 * - Session total: Shows cumulative tokens across main + subagent requests
 *
 * Sessions are tracked and aged:
 * - Active sessions show full brightness
 * - Sessions dim after 30s of inactivity
 * - Sessions are removed after 2min or when 5 newer sessions exist
 *
 * Clicking opens a tooltip with detailed breakdown.
 */
export class TokenStatusBar implements vscode.Disposable {
	private statusBarItem: vscode.StatusBarItem;
	private currentUsage: TokenUsage | null = null;
	private isStreaming = false;
	private hideTimeout: ReturnType<typeof setTimeout> | null = null;

	// Session tracking
	private sessions: Map<string, SessionEntry> = new Map();
	private activeSessionId: string | null = null;
	private cleanupInterval: ReturnType<typeof setInterval> | null = null;
	private streamingStartTime: number | null = null;

	constructor() {
		this.statusBarItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Right,
			100, // Priority - higher = more left
		);
		this.statusBarItem.name = "Vercel AI Token Usage";
		this.statusBarItem.command = "vercelAiGateway.showTokenDetails";
		this.hide();

		// Start cleanup interval for aging sessions
		this.cleanupInterval = setInterval(
			() => this.cleanupStaleSessions(),
			SESSION_CLEANUP_INTERVAL_MS,
		);
	}

	/**
	 * Generate a unique session ID
	 */
	generateSessionId(): string {
		return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	}

	/**
	 * Get the current active session ID, or null if none
	 */
	getActiveSessionId(): string | null {
		return this.activeSessionId;
	}

	/**
	 * Get all sessions (for debugging/display)
	 */
	getSessions(): SessionEntry[] {
		return Array.from(this.sessions.values()).sort((a, b) => b.lastUpdateTime - a.lastUpdateTime);
	}

	/**
	 * Get session totals across all active (non-dimmed) sessions
	 */
	getSessionTotals(): { inputTokens: number; outputTokens: number } {
		let inputTokens = 0;
		let outputTokens = 0;
		for (const session of this.sessions.values()) {
			if (!session.dimmed) {
				inputTokens += session.inputTokens;
				outputTokens += session.outputTokens;
			}
		}
		return { inputTokens, outputTokens };
	}

	/**
	 * Start a new session or join an existing one.
	 * Returns the session ID to use for subsequent updates.
	 */
	startSession(sessionId?: string, estimatedTokens?: number, maxTokens?: number): string {
		const now = Date.now();
		const id = sessionId ?? this.generateSessionId();

		// Check if joining an existing session
		const existing = this.sessions.get(id);
		if (existing) {
			// Joining existing session (e.g., subagent joining main agent's session)
			existing.lastUpdateTime = now;
			existing.status = "streaming";
			existing.requestCount += 1;
			existing.dimmed = false;
			if (maxTokens !== undefined) {
				existing.maxInputTokens = maxTokens;
			}
			logger.debug(
				`Session ${id} joined, request #${existing.requestCount}, ` +
					`cumulative: ${existing.inputTokens} in, ${existing.outputTokens} out`,
			);
		} else {
			// New session
			this.sessions.set(id, {
				id,
				startTime: now,
				lastUpdateTime: now,
				inputTokens: 0,
				outputTokens: 0,
				maxInputTokens: maxTokens,
				requestCount: 1,
				status: "streaming",
				dimmed: false,
			});
			logger.debug(`Session ${id} started`);
		}

		this.activeSessionId = id;
		this.streamingStartTime = now;
		this.showStreaming(estimatedTokens, maxTokens);

		return id;
	}

	/**
	 * Show streaming indicator when a request starts
	 */
	showStreaming(estimatedTokens?: number, maxTokens?: number): void {
		this.isStreaming = true;
		this.clearHideTimeout();

		const session = this.activeSessionId ? this.sessions.get(this.activeSessionId) : null;
		const elapsed = this.streamingStartTime
			? Math.round((Date.now() - this.streamingStartTime) / 1000)
			: 0;
		const elapsedStr = elapsed > 0 ? ` ${elapsed}s` : "";

		// Show session cumulative if we have prior requests
		const sessionSuffix =
			session && session.requestCount > 1 ? ` [${session.requestCount} reqs]` : "";

		if (estimatedTokens !== undefined && maxTokens !== undefined) {
			const percentage = Math.round((estimatedTokens / maxTokens) * 100);
			const formatted = this.formatTokenCount(estimatedTokens);
			const maxFormatted = this.formatTokenCount(maxTokens);
			this.statusBarItem.text = `$(loading~spin) ~${formatted}/${maxFormatted} (${percentage}%)${elapsedStr}${sessionSuffix}`;

			const tooltipLines = [
				`Estimated input: ${estimatedTokens.toLocaleString()} tokens`,
				`Model limit: ${maxTokens.toLocaleString()} tokens`,
			];
			if (session && session.requestCount > 1) {
				tooltipLines.push("");
				tooltipLines.push(
					`Session total: ${session.inputTokens.toLocaleString()} in, ${session.outputTokens.toLocaleString()} out`,
				);
				tooltipLines.push(`Requests in session: ${session.requestCount}`);
			}
			this.statusBarItem.tooltip = tooltipLines.join("\n");
		} else {
			this.statusBarItem.text = `$(loading~spin) Streaming...${elapsedStr}${sessionSuffix}`;
			this.statusBarItem.tooltip = "AI request in progress";
		}

		this.statusBarItem.backgroundColor = undefined;
		this.statusBarItem.show();
	}

	/**
	 * Update streaming progress with output token count
	 */
	updateStreamingProgress(outputTokensSoFar: number): void {
		if (!this.isStreaming) return;

		const session = this.activeSessionId ? this.sessions.get(this.activeSessionId) : null;
		const elapsed = this.streamingStartTime
			? Math.round((Date.now() - this.streamingStartTime) / 1000)
			: 0;
		const elapsedStr = elapsed > 0 ? ` ${elapsed}s` : "";

		const outputFormatted = this.formatTokenCount(outputTokensSoFar);
		const sessionSuffix =
			session && session.requestCount > 1 ? ` [${session.requestCount} reqs]` : "";

		// Update text to show output progress
		this.statusBarItem.text = `$(loading~spin) ${outputFormatted} out${elapsedStr}${sessionSuffix}`;

		if (session) {
			session.lastUpdateTime = Date.now();
		}
	}

	/**
	 * Update with actual token usage after request completes
	 */
	showUsage(usage: TokenUsage, sessionId?: string): void {
		this.isStreaming = false;
		this.currentUsage = usage;
		this.streamingStartTime = null;
		this.clearHideTimeout();

		// Update session with actual usage
		const sid = sessionId ?? this.activeSessionId;
		const session = sid ? this.sessions.get(sid) : null;
		if (session) {
			session.inputTokens += usage.inputTokens;
			session.outputTokens += usage.outputTokens;
			session.lastUpdateTime = Date.now();
			session.status = "complete";
			session.modelId = usage.modelId;
			if (usage.maxInputTokens !== undefined) {
				session.maxInputTokens = usage.maxInputTokens;
			}
			if (usage.contextManagement) {
				session.contextManagement = usage.contextManagement;
			}
			logger.debug(
				`Session ${sid} updated: ${session.inputTokens} in, ${session.outputTokens} out (${session.requestCount} requests)`,
			);
		}

		const inputFormatted = this.formatTokenCount(usage.inputTokens);
		const outputFormatted = this.formatTokenCount(usage.outputTokens);
		const contextEdits = usage.contextManagement?.appliedEdits ?? [];
		const hasCompaction = contextEdits.length > 0;
		const freedTokens = contextEdits.reduce((total, edit) => total + edit.clearedInputTokens, 0);
		const freedSuffix = hasCompaction ? ` ↓${this.formatTokenCount(freedTokens)}` : "";

		// Use a more prominent icon when compaction occurred
		const icon = hasCompaction ? "$(fold)" : "$(symbol-number)";

		// Show session info if multiple requests
		const sessionSuffix =
			session && session.requestCount > 1
				? ` [Σ${this.formatTokenCount(session.inputTokens)}]`
				: "";

		if (usage.maxInputTokens) {
			const percentage = Math.round((usage.inputTokens / usage.maxInputTokens) * 100);
			const maxFormatted = this.formatTokenCount(usage.maxInputTokens);

			// Color code based on usage percentage
			if (percentage >= 90) {
				this.statusBarItem.backgroundColor = new vscode.ThemeColor(
					"statusBarItem.warningBackground",
				);
			} else if (percentage >= 75) {
				this.statusBarItem.backgroundColor = new vscode.ThemeColor(
					"statusBarItem.prominentBackground",
				);
			} else {
				this.statusBarItem.backgroundColor = undefined;
			}

			this.statusBarItem.text = `${icon} ${inputFormatted}/${maxFormatted} (${outputFormatted} out)${freedSuffix}${sessionSuffix}`;
			this.statusBarItem.tooltip = this.buildTooltip(usage, percentage, session);
		} else {
			this.statusBarItem.backgroundColor = undefined;
			this.statusBarItem.text = `${icon} ${inputFormatted} in, ${outputFormatted} out${freedSuffix}${sessionSuffix}`;
			this.statusBarItem.tooltip = this.buildTooltip(usage, undefined, session);
		}

		this.statusBarItem.show();

		// Auto-hide after 30 seconds of inactivity
		this.hideTimeout = setTimeout(() => this.hide(), 30000);

		logger.debug(
			`Token usage: ${usage.inputTokens} in, ${usage.outputTokens} out${usage.maxInputTokens ? ` (${Math.round((usage.inputTokens / usage.maxInputTokens) * 100)}% of limit)` : ""}`,
		);
	}

	/**
	 * Mark a session as having an error
	 */
	markSessionError(sessionId?: string): void {
		const sid = sessionId ?? this.activeSessionId;
		const session = sid ? this.sessions.get(sid) : null;
		if (session) {
			session.status = "error";
			session.lastUpdateTime = Date.now();
		}
	}

	/**
	 * Show an error state
	 */
	showError(message: string): void {
		this.isStreaming = false;
		this.clearHideTimeout();

		this.statusBarItem.text = "$(error) Token limit exceeded";
		this.statusBarItem.tooltip = message;
		this.statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
		this.statusBarItem.show();

		// Keep error visible longer
		this.hideTimeout = setTimeout(() => this.hide(), 60000);
	}

	/**
	 * Hide the status bar item
	 */
	hide(): void {
		this.statusBarItem.hide();
		this.isStreaming = false;
	}

	/**
	 * Get the last recorded usage (for commands/tooltips)
	 */
	getLastUsage(): TokenUsage | null {
		return this.currentUsage;
	}

	/**
	 * Format token count for display (e.g., 1234 -> "1.2k", 128000 -> "128k")
	 */
	private formatTokenCount(count: number): string {
		if (count >= 1000000) {
			return `${(count / 1000000).toFixed(1)}M`;
		}
		if (count >= 1000) {
			return `${(count / 1000).toFixed(1)}k`;
		}
		return count.toString();
	}

	/**
	 * Build detailed tooltip text
	 */
	private buildTooltip(
		usage: TokenUsage,
		percentage?: number,
		session?: SessionEntry | null,
	): string {
		const lines: string[] = [];

		if (usage.modelId) {
			lines.push(`Model: ${usage.modelId}`);
			lines.push("");
		}

		lines.push(`Input tokens: ${usage.inputTokens.toLocaleString()}`);
		lines.push(`Output tokens: ${usage.outputTokens.toLocaleString()}`);
		lines.push(`Total: ${(usage.inputTokens + usage.outputTokens).toLocaleString()}`);

		if (usage.maxInputTokens && percentage !== undefined) {
			lines.push("");
			lines.push(`Context used: ${percentage}%`);
			lines.push(
				`Remaining: ${(usage.maxInputTokens - usage.inputTokens).toLocaleString()} tokens`,
			);

			if (percentage >= 90) {
				lines.push("");
				lines.push("⚠️ Approaching context limit");
			}
		}

		const contextEdits = usage.contextManagement?.appliedEdits ?? [];
		if (contextEdits.length > 0) {
			lines.push("");
			lines.push("⚡ Context compacted");
			lines.push(...this.formatContextEdits(contextEdits));
		}

		// Show session totals if multiple requests
		if (session && session.requestCount > 1) {
			lines.push("");
			lines.push("━━━ Session Totals ━━━");
			lines.push(`Requests: ${session.requestCount}`);
			lines.push(`Total input: ${session.inputTokens.toLocaleString()}`);
			lines.push(`Total output: ${session.outputTokens.toLocaleString()}`);
			const elapsed = Math.round((Date.now() - session.startTime) / 1000);
			if (elapsed > 60) {
				lines.push(`Duration: ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`);
			} else {
				lines.push(`Duration: ${elapsed}s`);
			}
		}

		lines.push("");
		lines.push("Click for details");

		return lines.join("\n");
	}

	/**
	 * Clean up stale sessions (dim old ones, remove very old ones)
	 */
	private cleanupStaleSessions(): void {
		const now = Date.now();
		const sessionsToRemove: string[] = [];

		// Sort sessions by last update time (newest first)
		const sortedSessions = Array.from(this.sessions.entries()).sort(
			([, a], [, b]) => b.lastUpdateTime - a.lastUpdateTime,
		);

		let activeCount = 0;
		for (const [id, session] of sortedSessions) {
			const age = now - session.lastUpdateTime;

			// Skip currently streaming sessions
			if (session.status === "streaming") {
				activeCount++;
				continue;
			}

			// Remove sessions that are too old
			if (age > SESSION_REMOVE_AFTER_MS) {
				sessionsToRemove.push(id);
				continue;
			}

			// Remove old sessions if we have too many newer ones
			if (activeCount >= SESSION_REMOVE_AFTER_REQUESTS && !session.dimmed) {
				sessionsToRemove.push(id);
				continue;
			}

			// Dim sessions that haven't been updated recently
			if (age > SESSION_DIM_AFTER_MS && !session.dimmed) {
				session.dimmed = true;
				logger.debug(`Session ${id} dimmed after ${Math.round(age / 1000)}s`);
			}

			if (!session.dimmed) {
				activeCount++;
			}
		}

		// Remove stale sessions
		for (const id of sessionsToRemove) {
			this.sessions.delete(id);
			logger.debug(`Session ${id} removed`);
			if (this.activeSessionId === id) {
				this.activeSessionId = null;
			}
		}

		// Update display if we have an active session
		if (this.activeSessionId && this.currentUsage && !this.isStreaming) {
			// Refresh the display to reflect any changes
			this.showUsage(this.currentUsage, this.activeSessionId);
		}
	}

	/**
	 * Manually clear all sessions (e.g., user command)
	 */
	clearSessions(): void {
		this.sessions.clear();
		this.activeSessionId = null;
		logger.debug("All sessions cleared");
	}

	private formatContextEdits(edits: ContextManagementEdit[]): string[] {
		return edits.map((edit) => {
			const freed = edit.clearedInputTokens.toLocaleString();
			switch (edit.type) {
				case "clear_tool_uses_20250919": {
					if (edit.clearedToolUses !== undefined) {
						const label = edit.clearedToolUses === 1 ? "tool use" : "tool uses";
						return `- ${edit.clearedToolUses} ${label} cleared (${freed} freed)`;
					}
					return `- Tool uses cleared (${freed} freed)`;
				}
				case "clear_thinking_20251015": {
					if (edit.clearedThinkingTurns !== undefined) {
						const label = edit.clearedThinkingTurns === 1 ? "thinking turn" : "thinking turns";
						return `- ${edit.clearedThinkingTurns} ${label} cleared (${freed} freed)`;
					}
					return `- Thinking turns cleared (${freed} freed)`;
				}
				default:
					return `- ${edit.type} (${freed} freed)`;
			}
		});
	}

	private clearHideTimeout(): void {
		if (this.hideTimeout) {
			clearTimeout(this.hideTimeout);
			this.hideTimeout = null;
		}
	}

	dispose(): void {
		this.clearHideTimeout();
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}
		this.sessions.clear();
		this.statusBarItem.dispose();
	}
}
