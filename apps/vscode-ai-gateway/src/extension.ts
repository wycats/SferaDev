console.log("[DIAG] extension.ts: TOP OF FILE - module loading");

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { createAgentTreeView } from "./agent-tree";
import { VercelAIAuthenticationProvider } from "./auth";
import { ConfigService, INFERENCE_DEFAULTS } from "./config";
import { EXTENSION_ID, VSCODE_EXTENSION_ID } from "./constants";
import { treeDiagnostics } from "./diagnostics/tree-diagnostics";
import { initializeOutputChannel, logger } from "./logger";
import { VercelAIChatModelProvider } from "./provider";
import { TokenStatusBar } from "./status-bar";
import { tryStringify } from "./utils/serialize.js";

console.log("[DIAG] extension.ts: imports complete");

// Build timestamp for reload detection - generated at build time
const BUILD_TIMESTAMP = new Date().toISOString();
// Build signature - change this when making significant changes to verify deployment
const BUILD_SIGNATURE = "disguised-system-prompt-fix";

export function activate(context: vscode.ExtensionContext) {
  console.log("[DIAG] extension.ts: activate() called");
  // Initialize the shared output channel FIRST - before any logging
  // This ensures there's exactly one output channel per VS Code window
  const outputChannelDisposable = initializeOutputChannel();
  context.subscriptions.push(outputChannelDisposable);

  // Get extension version from package.json
  const extension = vscode.extensions.getExtension(VSCODE_EXTENSION_ID);
  const packageJson = extension?.packageJSON as
    | { version?: string }
    | undefined;
  const version = packageJson?.version ?? "unknown";

  logger.info(
    `Vercel AI Gateway extension activating - v${version} [${BUILD_SIGNATURE}] (built: ${BUILD_TIMESTAMP})`,
  );
  logger.info(
    `Inference defaults: temperature=${INFERENCE_DEFAULTS.temperature.toString()}, topP=${INFERENCE_DEFAULTS.topP.toString()}, maxOutput=${INFERENCE_DEFAULTS.maxOutputTokens.toString()}`,
  );

  // Register the authentication provider
  const authProvider = new VercelAIAuthenticationProvider(context);
  context.subscriptions.push(authProvider);
  logger.debug("Authentication provider registered");

  const configService = new ConfigService();
  context.subscriptions.push(configService);

  // Initialize tree diagnostics (writes to .logs/tree-diagnostics.log)
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot) {
    treeDiagnostics.initialize(workspaceRoot);
    logger.debug(
      `Tree diagnostics initialized at ${workspaceRoot}/.logs/tree-diagnostics.log`,
    );
  }

  // Create the token status bar
  const statusBar = new TokenStatusBar();
  statusBar.initializePersistence(context);
  statusBar.setConfig({
    showOutputTokens: configService.statusBarShowOutputTokens,
  });
  context.subscriptions.push(statusBar);
  logger.debug("Token status bar created");

  // Create the agent tree view
  const { treeView, provider: treeProvider } = createAgentTreeView(statusBar);
  context.subscriptions.push(treeView);
  context.subscriptions.push(treeProvider);
  logger.debug("Agent tree view created");

  // Register refresh command for agent tree
  context.subscriptions.push(
    vscode.commands.registerCommand("vercelAiGateway.refreshAgentTree", () => {
      treeProvider.refresh();
    }),
  );

  // Watch for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vercelAiGateway.statusBar")) {
        statusBar.setConfig({
          showOutputTokens: configService.statusBarShowOutputTokens,
        });
      }
    }),
  );

  // Register the language model chat provider
  const provider = new VercelAIChatModelProvider(context, configService);
  provider.setStatusBar(statusBar);
  context.subscriptions.push(provider);
  const providerDisposable = vscode.lm.registerLanguageModelChatProvider(
    EXTENSION_ID,
    provider,
  );
  context.subscriptions.push(providerDisposable);
  logger.debug("Language model chat provider registered");

  // Register the chat participant (allows @vercel mentions in chat)
  const chatParticipant = vscode.chat.createChatParticipant(
    "vercelAiGateway.chat",
    async (request, context, response, token) => {
      logger.info(
        `[ChatParticipant] Received request: "${request.prompt.slice(0, 50)}..."`,
      );
      logger.debug(
        `[ChatParticipant] Model: ${request.model.id}, vendor: ${request.model.vendor}`,
      );
      logger.debug(
        `[ChatParticipant] History length: ${context.history.length}`,
      );

      // Build messages from the request
      const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(request.prompt),
      ];

      try {
        // Use the model selected in the chat (could be ours or another)
        const lmResponse = await request.model.sendRequest(messages, {}, token);

        // Stream the response back to the chat
        for await (const chunk of lmResponse.stream) {
          if (chunk instanceof vscode.LanguageModelTextPart) {
            response.markdown(chunk.value);
          } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
            logger.debug(
              `[ChatParticipant] Tool call: ${chunk.name}(${tryStringify(chunk.input)})`,
            );
          }
        }
      } catch (err) {
        logger.error(`[ChatParticipant] Error: ${String(err)}`);
        response.markdown(`**Error:** ${String(err)}`);
      }

      return { metadata: { handled: true } };
    },
  );
  context.subscriptions.push(chatParticipant);
  logger.debug("Chat participant registered: @vercel");

  // Register command to show token details
  const tokenDetailsCommand = vscode.commands.registerCommand(
    "vercelAiGateway.showTokenDetails",
    () => {
      const usage = statusBar.getLastUsage();
      if (!usage) {
        vscode.window.showInformationMessage(
          "No token usage data available yet.",
        );
        return;
      }

      const items: string[] = [
        `Input tokens: ${usage.inputTokens.toLocaleString()}`,
        `Output tokens: ${usage.outputTokens.toLocaleString()}`,
        `Total: ${(usage.inputTokens + usage.outputTokens).toLocaleString()}`,
      ];

      if (usage.maxInputTokens) {
        const percentage = Math.round(
          (usage.inputTokens / usage.maxInputTokens) * 100,
        );
        items.push(`Context used: ${percentage.toString()}%`);
        items.push(
          `Remaining: ${(usage.maxInputTokens - usage.inputTokens).toLocaleString()}`,
        );
      }

      if (usage.modelId) {
        items.unshift(`Model: ${usage.modelId}`);
      }

      vscode.window.showInformationMessage(items.join(" | "));
    },
  );
  context.subscriptions.push(tokenDetailsCommand);

  // Register command to dump agent tree diagnostics
  const dumpDiagnosticsCommand = vscode.commands.registerCommand(
    "vercelAiGateway.dumpDiagnostics",
    () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        vscode.window.showErrorMessage(
          "No workspace folder available for diagnostic dump.",
        );
        return;
      }

      const dump = statusBar.createDiagnosticDump(vscode.env.sessionId);
      const logDir = path.join(workspaceRoot, ".logs");
      try {
        fs.mkdirSync(logDir, { recursive: true });
      } catch (err) {
        logger.error(
          `[Diagnostics] Failed to create log directory: ${String(err)}`,
        );
        vscode.window.showErrorMessage(
          "Failed to create .logs directory for diagnostic dump.",
        );
        return;
      }

      const filePath = path.join(
        logDir,
        `diagnostic-dump-${dump.timestamp}.json`,
      );

      try {
        fs.writeFileSync(filePath, JSON.stringify(dump, null, 2));
      } catch (err) {
        logger.error(
          `[Diagnostics] Failed to write diagnostic dump: ${String(err)}`,
        );
        vscode.window.showErrorMessage("Failed to write diagnostic dump file.");
        return;
      }

      vscode.window.showInformationMessage(
        `Diagnostics written to ${filePath}`,
      );
    },
  );
  context.subscriptions.push(dumpDiagnosticsCommand);

  // Register command to manage authentication
  const commandDisposable = vscode.commands.registerCommand(
    `${EXTENSION_ID}.manage`,
    () => {
      void authProvider.manageAuthentication();
    },
  );
  context.subscriptions.push(commandDisposable);

  logger.info("Vercel AI Gateway extension activated successfully");

  // Export auth provider for use by other components
  return { authProvider };
}

export function deactivate() {
  logger.info("Vercel AI Gateway extension deactivating...");
}
