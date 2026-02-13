import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { EXTENSION_ID, VENDOR_ID, VSCODE_EXTENSION_ID } from "./constants";
import { initializeOutputChannel, logger } from "./logger";
import { StubProvider } from "./provider-stub";

const loadSerialize = (() => {
  let cached: Promise<{ tryStringify: (value: unknown) => string }> | undefined;
  return () => (cached ??= import("./utils/serialize.js"));
})();

export async function activate(context: vscode.ExtensionContext) {
  // Initialize the shared output channel FIRST - before any logging
  // This ensures there's exactly one output channel per VS Code window
  const outputChannelDisposable = initializeOutputChannel();
  context.subscriptions.push(outputChannelDisposable);

  // =====================================================================
  // Phase 1: Register stub provider IMMEDIATELY (before any await).
  //
  // The stub reads cached models from globalState synchronously, so VS Code's
  // model picker has our models available instantly on reload. Without this,
  // models wouldn't appear until the heavy async imports below complete.
  // =====================================================================
  const stubProvider = new StubProvider(context);
  context.subscriptions.push(stubProvider);

  const providerDisposable = vscode.lm.registerLanguageModelChatProvider(
    VENDOR_ID,
    stubProvider,
  );
  context.subscriptions.push(providerDisposable);

  // Signal models available immediately so VS Code resolves our cached models
  // into its live model cache before other providers' handlers run.
  stubProvider.notifyModelsAvailable();

  // =====================================================================
  // Phase 2: Load heavy modules asynchronously, then wire up the real provider.
  // =====================================================================

  // Get extension version from package.json
  const extension = vscode.extensions.getExtension(VSCODE_EXTENSION_ID);
  const packageJson = extension?.packageJSON as
    | { version?: string }
    | undefined;
  const version = packageJson?.version ?? "unknown";

  logger.info(`Vercel AI Gateway extension activating - v${version}`);

  const [
    { VercelAIAuthenticationProvider },
    { ConfigService, INFERENCE_DEFAULTS },
    { treeDiagnostics },
    { migrateStorageKeys },
    { VercelAIChatModelProvider },
    { TokenStatusBar },
    { createAgentTreeView },
  ] = await Promise.all([
    import("./auth"),
    import("./config"),
    import("./diagnostics/tree-diagnostics"),
    import("./persistence/migration.js"),
    import("./provider"),
    import("./status-bar"),
    import("./agent-tree"),
  ]);

  logger.info(
    `Inference defaults: temperature=${INFERENCE_DEFAULTS.temperature.toString()}, topP=${INFERENCE_DEFAULTS.topP.toString()}, maxOutput=${INFERENCE_DEFAULTS.maxOutputTokens.toString()}`,
  );

  // Migrate storage keys from old vercelAiGateway.* namespace to vercel.ai.*
  // This must run before any storage reads to ensure data continuity
  void migrateStorageKeys(context);

  // Register the authentication provider
  const authProvider = new VercelAIAuthenticationProvider(context);
  context.subscriptions.push(authProvider);

  const configService = new ConfigService();
  context.subscriptions.push(configService);

  // Initialize tree diagnostics (writes to .logs/tree-diagnostics.log)
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot) {
    treeDiagnostics.initialize(workspaceRoot);
  }

  // Create the token status bar
  const statusBar = new TokenStatusBar();
  statusBar.initializePersistence(context);
  context.subscriptions.push(statusBar);

  // Create the agent tree view
  const { treeView, provider: treeProvider } = createAgentTreeView(statusBar);
  context.subscriptions.push(treeView);
  context.subscriptions.push(treeProvider);

  // Register refresh command for agent tree
  context.subscriptions.push(
    vscode.commands.registerCommand("vercel.ai.refreshAgentTree", () => {
      treeProvider.refresh();
    }),
  );

  // Create the full provider and connect it to the stub.
  // The stub was already registered to win the boot-speed race.
  const provider = new VercelAIChatModelProvider(context, configService);
  provider.setStatusBar(statusBar);
  context.subscriptions.push(provider);

  stubProvider.setRealProvider(provider);

  // Register the chat participant (allows @vercel mentions in chat)
  const chatParticipant = vscode.chat.createChatParticipant(
    "vercel.ai.chat",
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
        const { tryStringify } = await loadSerialize();
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
    "vercel.ai.showTokenDetails",
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
    "vercel.ai.dumpDiagnostics",
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
        // eslint-disable-next-line no-restricted-syntax -- User-triggered diagnostic export, not logging
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

  // Register command to test summarization detection on current chat history
  const testSummarizationCommand = vscode.commands.registerCommand(
    "vercel.ai.testSummarizationDetection",
    async () => {
      const { detectSummarizationRequest } =
        await import("./provider/openresponses-chat.js");
      // Build synthetic summarization-shaped messages to test the detection pipeline
      const LanguageModelTextPart = (
        vscode as never as Record<string, new (v: string) => unknown>
      )["LanguageModelTextPart"];
      if (!LanguageModelTextPart) {
        vscode.window.showErrorMessage(
          "LanguageModelTextPart not available in this VS Code version.",
        );
        return;
      }

      const ROLE_USER = 1;
      const ROLE_SYSTEM = 3;
      const ROLE_ASSISTANT = 2;

      // Test case 1: Summarization by last-user-message pattern
      const summMessages1 = [
        {
          role: ROLE_SYSTEM,
          content: [new LanguageModelTextPart("You are a helpful assistant.")],
        },
        { role: ROLE_USER, content: [new LanguageModelTextPart("Hello")] },
        { role: ROLE_ASSISTANT, content: [new LanguageModelTextPart("Hi!")] },
        {
          role: ROLE_USER,
          content: [
            new LanguageModelTextPart(
              "Summarize the conversation history so far.",
            ),
          ],
        },
      ] as never;

      // Test case 2: Summarization by system-message SummaryPrompt
      const summMessages2 = [
        {
          role: ROLE_SYSTEM,
          content: [
            new LanguageModelTextPart(
              "Context: <Tag name='summary'>Previous discussion</Tag>",
            ),
          ],
        },
        { role: ROLE_USER, content: [new LanguageModelTextPart("Continue.")] },
      ] as never;

      // Test case 3: Normal chat (should NOT detect)
      const normalMessages = [
        {
          role: ROLE_SYSTEM,
          content: [new LanguageModelTextPart("You are a helpful assistant.")],
        },
        {
          role: ROLE_USER,
          content: [new LanguageModelTextPart("What is TypeScript?")],
        },
      ] as never;

      const start = performance.now();
      const result1 = detectSummarizationRequest(summMessages1);
      const t1 = performance.now() - start;

      const start2 = performance.now();
      const result2 = detectSummarizationRequest(summMessages2);
      const t2 = performance.now() - start2;

      const start3 = performance.now();
      const result3 = detectSummarizationRequest(normalMessages);
      const t3 = performance.now() - start3;

      const allCorrect =
        result1 === true && result2 === true && result3 === false;
      const icon = allCorrect ? "$(check)" : "$(error)";

      const details = [
        `${icon} Summarization Detection Test`,
        ``,
        `User-message pattern: ${result1 ? "DETECTED" : "MISSED"} (${t1.toFixed(2)}ms)`,
        `System SummaryPrompt: ${result2 ? "DETECTED" : "MISSED"} (${t2.toFixed(2)}ms)`,
        `Normal chat (expect false): ${result3 ? "FALSE POSITIVE" : "CORRECT"} (${t3.toFixed(2)}ms)`,
      ].join("\n");

      if (allCorrect) {
        vscode.window.showInformationMessage(
          `Summarization detection: All 3 cases passed (${(t1 + t2 + t3).toFixed(2)}ms total)`,
        );
      } else {
        vscode.window.showWarningMessage(
          `Summarization detection: FAILURES detected. Check output channel.`,
        );
      }
      logger.info(details);
    },
  );
  context.subscriptions.push(testSummarizationCommand);

  // Register command to prune investigation logs
  const pruneCommand = vscode.commands.registerCommand(
    "vercel.ai.investigation.prune",
    async () => {
      const { handlePruneCommand } =
        await import("./logger/investigation-prune-command.js");
      await handlePruneCommand();
    },
  );
  context.subscriptions.push(pruneCommand);

  // Fire-and-forget error log pruning on activation
  void (async () => {
    try {
      const { pruneErrorLogs } = await import(
        "./logger/error-capture-prune.js"
      );
      const errorsDir = path.join(context.globalStorageUri.fsPath, "errors");
      const result = await pruneErrorLogs(errorsDir);
      if (result.entriesRemoved > 0) {
        logger.info(
          `[ErrorCapture] Pruned ${result.entriesRemoved} old error logs (${result.filesDeleted} files, ${result.bytesFreed} bytes freed)`,
        );
      }
    } catch (err) {
      logger.warn(`[ErrorCapture] Error pruning logs: ${String(err)}`);
    }
  })();

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
