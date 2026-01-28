import * as vscode from "vscode";
import { VercelAIAuthenticationProvider } from "./auth";
import { EXTENSION_ID } from "./constants";
import { logger } from "./logger";
import { VercelAIChatModelProvider } from "./provider";

export function activate(context: vscode.ExtensionContext) {
	logger.info("Vercel AI Gateway extension activating...");

	// Register the authentication provider
	const authProvider = new VercelAIAuthenticationProvider(context);
	context.subscriptions.push(authProvider);
	logger.debug("Authentication provider registered");

	// Register the language model chat provider
	const provider = new VercelAIChatModelProvider(context);
	const providerDisposable = vscode.lm.registerLanguageModelChatProvider(EXTENSION_ID, provider);
	context.subscriptions.push(providerDisposable);
	logger.debug("Language model chat provider registered");

	// Register command to manage authentication
	const commandDisposable = vscode.commands.registerCommand(`${EXTENSION_ID}.manage`, () => {
		authProvider.manageAuthentication();
	});
	context.subscriptions.push(commandDisposable);

	// Dispose logger on deactivation
	context.subscriptions.push({ dispose: () => logger.dispose() });

	logger.info("Vercel AI Gateway extension activated successfully");

	// Export auth provider for use by other components
	return { authProvider };
}

export function deactivate() {
	logger.info("Vercel AI Gateway extension deactivating...");
}
