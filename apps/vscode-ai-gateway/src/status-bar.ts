import * as vscode from "vscode";
import { logger } from "./logger";

/**
 * Context management edit from Anthropic's API
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

/**
 * Token usage data from a completed request
 */
export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	maxInputTokens?: number;
	modelId?: string;
	contextManagement?: ContextManagementInfo;
}

/**
 * Agent entry tracking token usage for a single LM call
 */
export interface AgentEntry {
	id: string;
	/** Short display name (e.g., "recon", "execute", or hash) */
	name: string;
	startTime: number;
	lastUpdateTime: number;
	inputTokens: number;
	outputTokens: number;
	maxInputTokens?: number;
	estimatedInputTokens?: number;
	modelId?: string;
	status: "streaming" | "complete" | "error";
	contextManagement?: ContextManagementInfo;
	/** Whether this agent has been dimmed due to inactivity */
	dimmed: boolean;
	/** Is this the main/primary agent (first in conversation)? */
	isMain: boolean;
	/** Order in which this agent completed (for aging) */
	completionOrder?: number;
}

/** Agent aging configuration */
const AGENT_DIM_AFTER_REQUESTS = 2; // Dim after 2 newer agents complete
const AGENT_REMOVE_AFTER_REQUESTS = 5; // Remove after 5 newer agents complete
const AGENT_CLEANUP_INTERVAL_MS = 2_000; // Check for stale agents every 2 seconds

/**
 * Configuration interface (subset of ConfigService)
 */
export interface StatusBarConfig {
	showOutputTokens: boolean;
}

/**
 * Status bar item that displays token usage information with agent tracking.
 *
 * Shows:
 * - Main agent: "52k/128k" (input/max)
 * - With subagent active: "52k/128k | ▸ recon 8k/128k"
 * - With compaction: "$(fold) 52k/128k ↓15k"
 *
 * Agents are tracked and aged based on subsequent requests:
 * - Active agents show full visibility
 * - Agents dim after 2 newer agents complete
 * - Agents are removed after 5 newer agents complete
 */
export class TokenStatusBar implements vscode.Disposable {
	private statusBarItem: vscode.StatusBarItem;
	private currentUsage: TokenUsage | null = null;
	private hideTimeout: ReturnType<typeof setTimeout> | null = null;

	// Agent tracking
	private agents: Map<string, AgentEntry> = new Map();
	private mainAgentId: string | null = null;
	private activeAgentId: string | null = null;
	private cleanupInterval: ReturnType<typeof setInterval> | null = null;
	private completedAgentCount = 0;

	// Configuration
	private config: StatusBarConfig = { showOutputTokens: false };

	constructor() {
		this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.statusBarItem.name = "Vercel AI Token Usage";
		this.statusBarItem.command = "vercelAiGateway.showTokenDetails";
		this.hide();

		this.cleanupInterval = setInterval(() => this.cleanupStaleAgents(), AGENT_CLEANUP_INTERVAL_MS);
	}

	/**
	 * Update configuration
	 */
	setConfig(config: StatusBarConfig): void {
		this.config = config;
	}

	/**
	 * Extract a short name from agent context
	 */
	private extractAgentName(agentId: string, modelId?: string): string {
		// Try to extract from model ID (e.g., "anthropic:claude-sonnet-4" -> "claude-sonnet-4")
		if (modelId) {
			// If it contains a colon, extract after it
			const colonIdx = modelId.indexOf(":");
			if (colonIdx >= 0) {
				return modelId.slice(colonIdx + 1);
			}
			// Otherwise use the full modelId
			return modelId;
		}
		// Fall back to last 6 chars of agentId
		return agentId.slice(-6);
	}

	/**
	 * Start tracking a new agent (LM call)
	 */
	startAgent(
		agentId: string,
		estimatedTokens?: number,
		maxTokens?: number,
		modelId?: string,
	): string {
		const now = Date.now();
		const isMain = this.mainAgentId === null;

		if (isMain) {
			this.mainAgentId = agentId;
		}

		const agent: AgentEntry = {
			id: agentId,
			name: this.extractAgentName(agentId, modelId),
			startTime: now,
			lastUpdateTime: now,
			inputTokens: 0,
			outputTokens: 0,
			maxInputTokens: maxTokens,
			estimatedInputTokens: estimatedTokens,
			modelId,
			status: "streaming",
			dimmed: false,
			isMain,
		};

		this.agents.set(agentId, agent);
		this.activeAgentId = agentId;

		logger.debug(
			`[StatusBar] Agent STARTED`,
			JSON.stringify({
				timestamp: now,
				agentId,
				isMain,
				modelId,
				estimatedTokens,
				maxTokens,
				name: agent.name,
				totalAgents: this.agents.size,
				mainAgentId: this.mainAgentId,
				activeAgentId: this.activeAgentId,
			}),
		);

		this.updateDisplay();
		return agentId;
	}

	/**
	 * Update agent with completed usage
	 */
	completeAgent(agentId: string, usage: TokenUsage): void {
		const agent = this.agents.get(agentId);
		if (!agent) {
			logger.warn(`Agent ${agentId} not found for completion`);
			return;
		}

		agent.inputTokens = usage.inputTokens;
		agent.outputTokens = usage.outputTokens;
		agent.maxInputTokens = usage.maxInputTokens;
		agent.modelId = usage.modelId;
		agent.status = "complete";
		agent.lastUpdateTime = Date.now();
		agent.contextManagement = usage.contextManagement;
		agent.completionOrder = this.completedAgentCount;

		this.completedAgentCount++;
		this.currentUsage = usage;

		// If this was the active agent, clear it
		if (this.activeAgentId === agentId) {
			this.activeAgentId = null;
		}

		const contextEdits = usage.contextManagement?.appliedEdits ?? [];
		const freedTokens = contextEdits.reduce((sum, e) => sum + e.clearedInputTokens, 0);

		logger.debug(
			`[StatusBar] Agent COMPLETED`,
			JSON.stringify({
				timestamp: agent.lastUpdateTime,
				agentId,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				maxInputTokens: usage.maxInputTokens,
				modelId: usage.modelId,
				completionOrder: agent.completionOrder,
				completedAgentCount: this.completedAgentCount,
				isMain: agent.isMain,
				wasActive: this.activeAgentId === null,
				totalAgents: this.agents.size,
				contextManagement:
					contextEdits.length > 0
						? {
								editCount: contextEdits.length,
								freedTokens,
								edits: contextEdits.map((e) => ({
									type: e.type,
									clearedInputTokens: e.clearedInputTokens,
								})),
							}
						: null,
			}),
		);

		// Immediately age other agents based on new completion
		this.ageAgents();

		this.updateDisplay();
		this.scheduleHide();
	}

	/**
	 * Mark an agent as errored
	 */
	errorAgent(agentId: string): void {
		const agent = this.agents.get(agentId);
		const now = Date.now();
		if (agent) {
			agent.status = "error";
			agent.lastUpdateTime = now;
			agent.completionOrder = this.completedAgentCount;
			this.completedAgentCount++;

			logger.debug(
				`[StatusBar] Agent ERRORED`,
				JSON.stringify({
					timestamp: now,
					agentId,
					isMain: agent.isMain,
					completionOrder: agent.completionOrder,
					completedAgentCount: this.completedAgentCount,
					totalAgents: this.agents.size,
				}),
			);
		} else {
			logger.warn(
				`[StatusBar] errorAgent called for unknown agent`,
				JSON.stringify({ timestamp: now, agentId }),
			);
		}
		if (this.activeAgentId === agentId) {
			this.activeAgentId = null;
		}
		this.updateDisplay();
	}

	/**
	 * Show error state
	 */
	showError(message: string): void {
		this.clearHideTimeout();
		this.statusBarItem.text = "$(error) Token limit exceeded";
		this.statusBarItem.tooltip = message;
		this.statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
		this.statusBarItem.show();
		this.hideTimeout = setTimeout(() => this.hide(), 60000);
	}

	/**
	 * Update the status bar display based on current agent state
	 */
	private updateDisplay(): void {
		this.clearHideTimeout();

		// Debug: Log all agents state
		const agentsSummary = Array.from(this.agents.values()).map((a) => ({
			id: a.id.slice(-8),
			name: a.name,
			status: a.status,
			isMain: a.isMain,
			dimmed: a.dimmed,
			inputTokens: a.inputTokens,
			estimatedInputTokens: a.estimatedInputTokens,
			completionOrder: a.completionOrder,
			contextEdits: a.contextManagement?.appliedEdits?.length ?? 0,
		}));
		logger.debug(
			`[StatusBar] updateDisplay called`,
			JSON.stringify({
				timestamp: Date.now(),
				mainAgentId: this.mainAgentId?.slice(-8),
				activeAgentId: this.activeAgentId?.slice(-8),
				completedAgentCount: this.completedAgentCount,
				agents: agentsSummary,
			}),
		);

		const mainAgent = this.mainAgentId ? this.agents.get(this.mainAgentId) : null;
		const activeAgent = this.activeAgentId ? this.agents.get(this.activeAgentId) : null;

		// Build main part of display
		let mainText = "";
		let icon = "$(symbol-number)";

		if (mainAgent) {
			const hasCompaction = (mainAgent.contextManagement?.appliedEdits?.length ?? 0) > 0;
			if (hasCompaction) {
				icon = "$(fold)";
			}

			if (mainAgent.status === "streaming") {
				icon = "$(loading~spin)";
				if (mainAgent.estimatedInputTokens && mainAgent.maxInputTokens) {
					const pct = this.formatPercentage(
						mainAgent.estimatedInputTokens,
						mainAgent.maxInputTokens,
					);
					mainText = `~${this.formatTokenCount(mainAgent.estimatedInputTokens)}/${this.formatTokenCount(mainAgent.maxInputTokens)} (${pct})`;
				} else {
					mainText = "streaming...";
				}
			} else {
				mainText = this.formatAgentUsage(mainAgent);
			}

			// Add compaction suffix
			if (hasCompaction) {
				const freed =
					mainAgent.contextManagement?.appliedEdits.reduce((t, e) => t + e.clearedInputTokens, 0) ??
					0;
				// Use unpadded format for compaction suffix since it's less critical
				mainText += ` ↓${this.formatTokenCount(freed, false)}`;
			}
		}

		// Build subagent part (if active and not main)
		let subagentText = "";
		if (activeAgent && activeAgent.id !== this.mainAgentId) {
			if (activeAgent.status === "streaming") {
				if (activeAgent.estimatedInputTokens && activeAgent.maxInputTokens) {
					const pct = this.formatPercentage(
						activeAgent.estimatedInputTokens,
						activeAgent.maxInputTokens,
					);
					subagentText = ` | ▸ ${activeAgent.name} ~${this.formatTokenCount(activeAgent.estimatedInputTokens)}/${this.formatTokenCount(activeAgent.maxInputTokens)} (${pct})`;
				} else {
					subagentText = ` | ▸ ${activeAgent.name}...`;
				}
			} else {
				subagentText = ` | ${activeAgent.name}: ${this.formatAgentUsage(activeAgent)}`;
			}
		}

		// Combine
		if (mainText || subagentText) {
			this.statusBarItem.text = `${icon} ${mainText}${subagentText}`.trim();
			this.statusBarItem.tooltip = this.buildTooltip();
			this.setBackgroundColor(mainAgent);
			this.statusBarItem.show();
		} else {
			this.hide();
		}
	}

	/**
	 * Format usage for a single agent
	 */
	private formatAgentUsage(agent: AgentEntry): string {
		const input = this.formatTokenCount(agent.inputTokens);

		if (agent.maxInputTokens) {
			const max = this.formatTokenCount(agent.maxInputTokens);
			if (this.config.showOutputTokens) {
				return `${input}/${max} (${this.formatTokenCount(agent.outputTokens)} out)`;
			}
			return `${input}/${max}`;
		}

		if (this.config.showOutputTokens) {
			return `${input} in, ${this.formatTokenCount(agent.outputTokens)} out`;
		}
		return `${input} in`;
	}

	/**
	 * Set background color based on usage percentage
	 */
	private setBackgroundColor(agent: AgentEntry | null | undefined): void {
		if (!agent || !agent.maxInputTokens) {
			this.statusBarItem.backgroundColor = undefined;
			return;
		}

		const tokens =
			agent.status === "streaming" ? (agent.estimatedInputTokens ?? 0) : agent.inputTokens;
		const percentage = Math.round((tokens / agent.maxInputTokens) * 100);

		if (percentage >= 90) {
			this.statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
		} else if (percentage >= 75) {
			this.statusBarItem.backgroundColor = new vscode.ThemeColor(
				"statusBarItem.prominentBackground",
			);
		} else {
			this.statusBarItem.backgroundColor = undefined;
		}
	}

	/**
	 * Build tooltip with all agent details
	 */
	private buildTooltip(): string {
		const lines: string[] = [];

		// Get all non-dimmed agents, sorted by start time
		const visibleAgents = Array.from(this.agents.values())
			.filter((a) => !a.dimmed)
			.sort((a, b) => a.startTime - b.startTime);

		logger.debug(
			`[StatusBar] buildTooltip`,
			JSON.stringify({
				timestamp: Date.now(),
				visibleCount: visibleAgents.length,
				agents: visibleAgents.map((a) => ({
					id: a.id.slice(-8),
					name: a.name,
					status: a.status,
					isMain: a.isMain,
					inputTokens: a.inputTokens,
					estimatedInputTokens: a.estimatedInputTokens,
					contextEdits: a.contextManagement?.appliedEdits?.length ?? 0,
				})),
			}),
		);

		for (const agent of visibleAgents) {
			const prefix = agent.isMain ? "Main" : agent.name;
			const statusIcon =
				agent.status === "streaming" ? "⏳" : agent.status === "error" ? "❌" : "✓";

			if (agent.modelId) {
				lines.push(`${statusIcon} ${prefix} (${agent.modelId})`);
			} else {
				lines.push(`${statusIcon} ${prefix}`);
			}

			if (agent.status === "complete" || agent.status === "error") {
				lines.push(`   Input: ${agent.inputTokens.toLocaleString()}`);
				if (this.config.showOutputTokens) {
					lines.push(`   Output: ${agent.outputTokens.toLocaleString()}`);
				}
				if (agent.maxInputTokens) {
					const pct = Math.round((agent.inputTokens / agent.maxInputTokens) * 100);
					lines.push(`   Context: ${pct}% of ${agent.maxInputTokens.toLocaleString()}`);
				}
			} else if (agent.estimatedInputTokens) {
				lines.push(`   Estimated: ~${agent.estimatedInputTokens.toLocaleString()}`);
			}

			// Context compaction
			const edits = agent.contextManagement?.appliedEdits ?? [];
			if (edits.length > 0) {
				lines.push("   ⚡ Context compacted:");
				for (const edit of edits) {
					lines.push(`      ${this.formatContextEdit(edit)}`);
				}
			}

			lines.push("");
		}

		if (lines.length > 0) {
			lines.pop(); // Remove trailing empty line
		}

		lines.push("");
		lines.push("Click for details");

		return lines.join("\n");
	}

	/**
	 * Format a single context edit
	 */
	private formatContextEdit(edit: ContextManagementEdit): string {
		const freed = edit.clearedInputTokens.toLocaleString();
		switch (edit.type) {
			case "clear_tool_uses_20250919":
				if (edit.clearedToolUses !== undefined) {
					return `${edit.clearedToolUses} tool uses cleared (${freed} freed)`;
				}
				return `Tool uses cleared (${freed} freed)`;
			case "clear_thinking_20251015":
				if (edit.clearedThinkingTurns !== undefined) {
					return `${edit.clearedThinkingTurns} thinking turns cleared (${freed} freed)`;
				}
				return `Thinking turns cleared (${freed} freed)`;
			default:
				return `${edit.type} (${freed} freed)`;
		}
	}

	/**
	 * Age agents based on completed request count (dim and remove old agents)
	 */
	private ageAgents(): void {
		const agentsToRemove: string[] = [];
		const agentsDimmed: string[] = [];

		for (const [id, agent] of this.agents) {
			// Skip streaming agents
			if (agent.status === "streaming") continue;
			// Skip agents without completion order
			if (agent.completionOrder === undefined) continue;

			// Calculate how many agents have completed since this one
			const agentAge = this.completedAgentCount - agent.completionOrder - 1;

			if (agentAge >= AGENT_REMOVE_AFTER_REQUESTS) {
				agentsToRemove.push(id);
			} else if (agentAge >= AGENT_DIM_AFTER_REQUESTS && !agent.dimmed) {
				agent.dimmed = true;
				agentsDimmed.push(id);
			}
		}

		for (const id of agentsToRemove) {
			this.agents.delete(id);
			if (this.mainAgentId === id) {
				this.mainAgentId = null;
			}
		}

		if (agentsDimmed.length > 0 || agentsToRemove.length > 0) {
			logger.debug(
				`[StatusBar] Agents aged`,
				JSON.stringify({
					timestamp: Date.now(),
					dimmed: agentsDimmed.map((id) => id.slice(-8)),
					removed: agentsToRemove.map((id) => id.slice(-8)),
					completedAgentCount: this.completedAgentCount,
					remainingAgents: this.agents.size,
				}),
			);
		}
	}

	/**
	 * Clean up stale agents (periodic check)
	 */
	private cleanupStaleAgents(): void {
		const countBefore = this.agents.size;
		this.ageAgents();

		// If we removed agents, update display
		if (this.agents.size < countBefore) {
			this.updateDisplay();
		}
	}

	/**
	 * Format token count for display.
	 * Uses figure space (U+2007) padding for consistent width to prevent status bar bouncing.
	 * Target widths: "XXX.Xk" (6 chars) for k values, "X.XM" (4 chars) for M values.
	 */
	private formatTokenCount(count: number, padded = true): string {
		// Figure space has the same width as digits in most fonts
		const figureSpace = "\u2007";

		if (count >= 1000000) {
			const formatted = `${(count / 1000000).toFixed(1)}M`;
			// Pad to 5 chars: "X.XM" or "XX.XM"
			if (padded) {
				return formatted.padStart(5, figureSpace);
			}
			return formatted;
		}
		if (count >= 1000) {
			const formatted = `${(count / 1000).toFixed(1)}k`;
			// Pad to 6 chars: "X.Xk" → "XXX.Xk"
			if (padded) {
				return formatted.padStart(6, figureSpace);
			}
			return formatted;
		}
		// Small numbers: pad to 3 chars
		const formatted = count.toString();
		if (padded) {
			return formatted.padStart(3, figureSpace);
		}
		return formatted;
	}

	/**
	 * Format percentage with consistent width (always 3 chars + %).
	 * Uses figure space padding: " 5%" → "99%"
	 */
	private formatPercentage(current: number, max: number): string {
		const figureSpace = "\u2007";
		const pct = Math.round((current / max) * 100);
		// Clamp to 0-100 and pad to 3 chars
		const clamped = Math.min(100, Math.max(0, pct));
		return `${clamped.toString().padStart(3, figureSpace)}%`;
	}

	/**
	 * Schedule auto-hide
	 */
	private scheduleHide(): void {
		this.clearHideTimeout();
		this.hideTimeout = setTimeout(() => this.hide(), 30000);
	}

	private clearHideTimeout(): void {
		if (this.hideTimeout) {
			clearTimeout(this.hideTimeout);
			this.hideTimeout = null;
		}
	}

	hide(): void {
		this.statusBarItem.hide();
	}

	/**
	 * Get the last recorded usage
	 */
	getLastUsage(): TokenUsage | null {
		return this.currentUsage;
	}

	/**
	 * Clear all agents (reset state)
	 */
	clearAgents(): void {
		const previousCount = this.agents.size;
		this.agents.clear();
		this.mainAgentId = null;
		this.activeAgentId = null;
		this.completedAgentCount = 0;
		logger.debug(
			`[StatusBar] All agents CLEARED`,
			JSON.stringify({
				timestamp: Date.now(),
				previousAgentCount: previousCount,
			}),
		);
	}

	/**
	 * Get all agents for debugging
	 */
	getAgents(): AgentEntry[] {
		return Array.from(this.agents.values());
	}

	dispose(): void {
		this.clearHideTimeout();
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}
		this.agents.clear();
		this.statusBarItem.dispose();
	}
}
