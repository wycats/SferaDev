/**
 * Token estimation utilities for the Vercel AI Gateway extension.
 *
 * Provides configurable token estimation with different accuracy/safety tradeoffs.
 */

import { ConfigService } from "../config";

export type EstimationMode = "conservative" | "balanced" | "aggressive";

/**
 * Characters per token for each estimation mode.
 * Lower values = more conservative (overestimate tokens).
 * Higher values = more aggressive (underestimate tokens).
 */
export const ESTIMATION_MODES: Record<EstimationMode, number> = {
	conservative: 3, // Overestimate tokens to avoid context overflow
	balanced: 4, // Balance between accuracy and safety
	aggressive: 5, // Underestimate tokens for maximum context usage
};

export interface TokenEstimatorConfig {
	estimationMode: EstimationMode;
	charsPerToken: number | undefined;
}

export class TokenEstimator {
	private config: TokenEstimatorConfig;
	private configService: ConfigService;
	private readonly disposable: { dispose: () => void };

	constructor(configService: ConfigService = new ConfigService()) {
		this.configService = configService;
		this.config = this.loadConfig();

		this.disposable = this.configService.onDidChange(() => {
			this.config = this.loadConfig();
		});
	}

	private loadConfig(): TokenEstimatorConfig {
		return {
			estimationMode: this.configService.tokensEstimationMode as EstimationMode,
			charsPerToken: this.configService.tokensCharsPerToken,
		};
	}

	dispose(): void {
		this.disposable.dispose();
	}

	/**
	 * Get the current characters per token value.
	 * Uses custom override if set, otherwise uses the mode's default.
	 */
	getCharsPerToken(): number {
		if (this.config.charsPerToken !== undefined) {
			return this.config.charsPerToken;
		}
		return ESTIMATION_MODES[this.config.estimationMode];
	}

	/**
	 * Get the current estimation mode.
	 */
	getMode(): EstimationMode {
		return this.config.estimationMode;
	}

	/**
	 * Estimate the number of tokens in a text string.
	 * Always rounds up to be conservative.
	 */
	estimateTokens(text: string): number {
		if (!text) return 0;
		const charsPerToken = this.getCharsPerToken();
		return Math.ceil(text.length / charsPerToken);
	}

	/**
	 * Calculate the percentage of context window used.
	 * @param usedTokens - Number of tokens used
	 * @param maxTokens - Maximum tokens in context window
	 * @returns Percentage (0-100) of context used, rounded to 2 decimal places
	 */
	estimateContextUsage(usedTokens: number, maxTokens: number): number {
		if (maxTokens <= 0) return 100;
		const percentage = (usedTokens / maxTokens) * 100;
		return Math.min(100, Math.round(percentage * 100) / 100);
	}
}
