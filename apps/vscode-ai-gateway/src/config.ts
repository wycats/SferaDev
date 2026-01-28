import * as vscode from "vscode";
import {
	DEFAULT_BASE_URL,
	DEFAULT_REASONING_EFFORT,
	DEFAULT_SYSTEM_PROMPT_MESSAGE,
	DEFAULT_TIMEOUT_MS,
} from "./constants";

export type ReasoningEffort = "low" | "medium" | "high";
export type LogLevel = "off" | "error" | "warn" | "info" | "debug";
export type EstimationMode = "conservative" | "balanced" | "aggressive";

export class ConfigService implements vscode.Disposable {
	private config: vscode.WorkspaceConfiguration;
	private readonly emitter = new vscode.EventEmitter<void>();
	private readonly disposable: vscode.Disposable;

	constructor() {
		this.config = vscode.workspace.getConfiguration("vercelAiGateway");
		this.disposable = vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("vercelAiGateway")) {
				this.config = vscode.workspace.getConfiguration("vercelAiGateway");
				this.emitter.fire();
			}
		});
	}

	get onDidChange(): vscode.Event<void> {
		return this.emitter.event;
	}

	dispose(): void {
		this.disposable.dispose();
		this.emitter.dispose();
	}

	get endpoint(): string {
		return this.config.get("endpoint", DEFAULT_BASE_URL);
	}

	get gatewayBaseUrl(): string {
		const trimmed = this.endpoint.replace(/\/+$/, "");
		return `${trimmed}/v1/ai`;
	}

	get timeout(): number {
		return this.config.get("timeout", DEFAULT_TIMEOUT_MS);
	}

	get reasoningEffort(): ReasoningEffort {
		return this.config.get("reasoning.defaultEffort", DEFAULT_REASONING_EFFORT);
	}

	get systemPromptEnabled(): boolean {
		return this.config.get("systemPrompt.enabled", false);
	}

	get systemPromptMessage(): string {
		return this.config.get("systemPrompt.message", DEFAULT_SYSTEM_PROMPT_MESSAGE);
	}

	get logLevel(): LogLevel {
		return this.config.get("logging.level", "warn");
	}

	get logOutputChannel(): boolean {
		return this.config.get("logging.outputChannel", true);
	}

	get modelsAllowlist(): string[] {
		return this.config.get("models.allowlist", []);
	}

	get modelsDenylist(): string[] {
		return this.config.get("models.denylist", []);
	}

	get modelsFallbacks(): Record<string, string[]> {
		return this.config.get("models.fallbacks", {});
	}

	get modelsDefault(): string {
		return this.config.get("models.default", "");
	}

	get tokensEstimationMode(): EstimationMode {
		return this.config.get("tokens.estimationMode", "balanced");
	}

	get tokensCharsPerToken(): number | undefined {
		return this.config.get("tokens.charsPerToken", undefined);
	}
}
