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
 * Status bar item that displays token usage information.
 *
 * Shows:
 * - During request: "$(loading~spin) Tokens: estimating..."
 * - After completion: "$(symbol-number) 1.2k/128k tokens (95 out)"
 * - Idle: Hidden or shows last usage
 *
 * Clicking opens a tooltip with detailed breakdown.
 */
export class TokenStatusBar implements vscode.Disposable {
	private statusBarItem: vscode.StatusBarItem;
	private currentUsage: TokenUsage | null = null;
	private isStreaming = false;
	private hideTimeout: ReturnType<typeof setTimeout> | null = null;

	constructor() {
		this.statusBarItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Right,
			100, // Priority - higher = more left
		);
		this.statusBarItem.name = "Vercel AI Token Usage";
		this.statusBarItem.command = "vercelAiGateway.showTokenDetails";
		this.hide();
	}

	/**
	 * Show streaming indicator when a request starts
	 */
	showStreaming(estimatedTokens?: number, maxTokens?: number): void {
		this.isStreaming = true;
		this.clearHideTimeout();

		if (estimatedTokens !== undefined && maxTokens !== undefined) {
			const percentage = Math.round((estimatedTokens / maxTokens) * 100);
			const formatted = this.formatTokenCount(estimatedTokens);
			const maxFormatted = this.formatTokenCount(maxTokens);
			this.statusBarItem.text = `$(loading~spin) ~${formatted}/${maxFormatted} (${percentage}%)`;
			this.statusBarItem.tooltip = `Estimated input: ${estimatedTokens.toLocaleString()} tokens\nModel limit: ${maxTokens.toLocaleString()} tokens`;
		} else {
			this.statusBarItem.text = "$(loading~spin) Streaming...";
			this.statusBarItem.tooltip = "AI request in progress";
		}

		this.statusBarItem.backgroundColor = undefined;
		this.statusBarItem.show();
	}

	/**
	 * Update with actual token usage after request completes
	 */
	showUsage(usage: TokenUsage): void {
		this.isStreaming = false;
		this.currentUsage = usage;
		this.clearHideTimeout();

		const inputFormatted = this.formatTokenCount(usage.inputTokens);
		const outputFormatted = this.formatTokenCount(usage.outputTokens);
		const contextEdits = usage.contextManagement?.appliedEdits ?? [];
		const hasCompaction = contextEdits.length > 0;
		const freedTokens = contextEdits.reduce((total, edit) => total + edit.clearedInputTokens, 0);
		const freedSuffix = hasCompaction ? ` ↓${this.formatTokenCount(freedTokens)}` : "";
		const icon = hasCompaction ? "$(fold)" : "$(symbol-number)";

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

			this.statusBarItem.text = `${icon} ${inputFormatted}/${maxFormatted} (${outputFormatted} out)${freedSuffix}`;
			this.statusBarItem.tooltip = this.buildTooltip(usage, percentage);
		} else {
			this.statusBarItem.backgroundColor = undefined;
			this.statusBarItem.text = `${icon} ${inputFormatted} in, ${outputFormatted} out${freedSuffix}`;
			this.statusBarItem.tooltip = this.buildTooltip(usage);
		}

		this.statusBarItem.show();

		// Auto-hide after 30 seconds of inactivity
		this.hideTimeout = setTimeout(() => this.hide(), 30000);

		logger.debug(
			`Token usage: ${usage.inputTokens} in, ${usage.outputTokens} out${usage.maxInputTokens ? ` (${Math.round((usage.inputTokens / usage.maxInputTokens) * 100)}% of limit)` : ""}`,
		);
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
	private buildTooltip(usage: TokenUsage, percentage?: number): string {
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

		lines.push("");
		lines.push("Click for details");

		return lines.join("\n");
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
		this.statusBarItem.dispose();
	}
}
