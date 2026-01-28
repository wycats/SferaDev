import * as vscode from "vscode";
import { VercelAIAuthenticationProvider } from "./auth";
import { ConfigService } from "./config";
import { EXTENSION_ID } from "./constants";
import { initializeOutputChannel, logger } from "./logger";
import { VercelAIChatModelProvider } from "./provider";
import { TokenStatusBar } from "./status-bar";

export function activate(context: vscode.ExtensionContext) {
	// Initialize the shared output channel FIRST - before any logging
	// This ensures there's exactly one output channel per VS Code window
	const outputChannelDisposable = initializeOutputChannel();
	context.subscriptions.push(outputChannelDisposable);

	logger.info("Vercel AI Gateway extension activating...");

	// Register the authentication provider
	const authProvider = new VercelAIAuthenticationProvider(context);
	context.subscriptions.push(authProvider);
	logger.debug("Authentication provider registered");

	const configService = new ConfigService();
	context.subscriptions.push(configService);

	// Create the token status bar
	const statusBar = new TokenStatusBar();
	context.subscriptions.push(statusBar);
	logger.debug("Token status bar created");

	// Register the language model chat provider
	const provider = new VercelAIChatModelProvider(context, configService);
	provider.setStatusBar(statusBar);
	context.subscriptions.push(provider);
	const providerDisposable = vscode.lm.registerLanguageModelChatProvider(EXTENSION_ID, provider);
	context.subscriptions.push(providerDisposable);
	logger.debug("Language model chat provider registered");

	// Register command to show token details
	const tokenDetailsCommand = vscode.commands.registerCommand(
		"vercelAiGateway.showTokenDetails",
		() => {
			const usage = statusBar.getLastUsage();
			if (!usage) {
				vscode.window.showInformationMessage("No token usage data available yet.");
				return;
			}

			const items: string[] = [
				`Input tokens: ${usage.inputTokens.toLocaleString()}`,
				`Output tokens: ${usage.outputTokens.toLocaleString()}`,
				`Total: ${(usage.inputTokens + usage.outputTokens).toLocaleString()}`,
			];

			if (usage.maxInputTokens) {
				const percentage = Math.round((usage.inputTokens / usage.maxInputTokens) * 100);
				items.push(`Context used: ${percentage}%`);
				items.push(`Remaining: ${(usage.maxInputTokens - usage.inputTokens).toLocaleString()}`);
			}

			if (usage.modelId) {
				items.unshift(`Model: ${usage.modelId}`);
			}

			vscode.window.showInformationMessage(items.join(" | "));
		},
	);
	context.subscriptions.push(tokenDetailsCommand);

	// Register command to manage authentication
	const commandDisposable = vscode.commands.registerCommand(`${EXTENSION_ID}.manage`, () => {
		authProvider.manageAuthentication();
	});
	context.subscriptions.push(commandDisposable);

	logger.info("Vercel AI Gateway extension activated successfully");

	// Export auth provider for use by other components
	return { authProvider };
}

export function deactivate() {
	logger.info("Vercel AI Gateway extension deactivating...");
}
