import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { runTests } from "@vscode/test-electron";

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function main(): Promise<void> {
  // Load .env file from extension root for API keys
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const extensionRoot = path.resolve(__dirname, "../..");
  const envResult = config({ path: path.join(extensionRoot, ".env") });
  if (envResult.parsed) {
    console.log(
      `Loaded .env with keys: ${Object.keys(envResult.parsed).join(", ")}`,
    );
  }

  // Debug: Log DISPLAY
  console.log(`DISPLAY in runTest.ts: ${process.env["DISPLAY"]}`);

  // Safety check: Ensure we are running via the wrapper script (for xvfb support)
  // or via the VS Code debugger (which sets extensionHost type)
  const isWrapper = process.env["VSCODE_TEST_WRAPPER"] === "true";
  const isDebugger = process.env["VSCODE_PID"] !== undefined; // VS Code sets this when debugging

  if (!isWrapper && !isDebugger) {
    writeStderr("ERROR: Do not run this script directly.");
    writeStderr(
      "Use 'pnpm test:integration' (which handles xvfb on Linux) or the VS Code debugger (F5 → Extension Tests).",
    );
    process.exit(1);
  }

  // __dirname is out/test, so ../.. goes to vscode-ai-gateway (the extension root)
  // (already computed above for .env loading)
  const extensionDevelopmentPath = extensionRoot;
  const extensionTestsPath = path.resolve(__dirname, "./suite/index.js");

  console.log(`Extension path: ${extensionDevelopmentPath}`);
  console.log(`Test path: ${extensionTestsPath}`);

  // @vscode/test-electron automatically:
  // - Uses .vscode-test/user-data for user data (isolation from running VS Code)
  // - Uses .vscode-test/extensions for extensions
  // - Adds --no-sandbox, --disable-gpu-sandbox, --disable-updates, etc.
  //
  // Per https://github.com/microsoft/vscode-test/issues/58, using a distinct
  // user-data-dir allows tests to run while VS Code is open.

  // On immutable Linux distros (Silverblue/Bazzite), the downloaded VS Code binary
  // has native module compatibility issues. Use system VS Code if available.
  // Note: Use the actual binary, not the wrapper script at /usr/bin/code
  const systemVscodePath = process.env["VSCODE_PATH"] ?? "/usr/share/code/code";
  const useSystemVscode =
    process.platform === "linux" && process.env["USE_SYSTEM_VSCODE"] === "true";

  if (useSystemVscode) {
    console.log(`Using system VS Code: ${systemVscodePath}`);
  }

  // Determine user-data-dir strategy:
  // - USE_SYSTEM_USER_DATA=true: Use system VS Code's user data (preserves auth)
  // - Otherwise: Create isolated user-data-dir (safe for parallel runs)
  const useSystemUserData = process.env["USE_SYSTEM_USER_DATA"] === "true";

  let userDataDir: string;
  if (useSystemUserData) {
    // Use the system VS Code's user data directory to preserve GitHub auth
    // This allows Copilot to work without re-authenticating
    userDataDir = path.join(
      process.env["HOME"] ?? process.env["USERPROFILE"] ?? "",
      ".config",
      "Code",
    );
    console.log(`Using SYSTEM user data dir (preserves auth): ${userDataDir}`);
    console.log(
      "WARNING: Close VS Code before running tests to avoid conflicts!",
    );
  } else {
    // Create unique user-data-dir to isolate from running VS Code instance
    // This is critical for running tests while VS Code is open
    userDataDir = path.resolve(
      extensionDevelopmentPath,
      ".vscode-test",
      "user-data-" + Date.now().toString(),
    );
    console.log(`User data dir (isolated): ${userDataDir}`);
  }

  // Pre-create user settings for the test environment
  // This enables features needed for testing (like making models user-selectable)
  // Skip this when using system user data to preserve existing settings
  if (!useSystemUserData) {
    const userSettingsDir = path.join(userDataDir, "User");
    fs.mkdirSync(userSettingsDir, { recursive: true });
    const testSettings = {
      // Make all models user-selectable so they appear in the chat model picker
      "vercelAiGateway.models.userSelectable": true,
      // Enable forensic capture for debugging
      "vercelAiGateway.debug.forensicCapture": true,
      // Set logging to debug level for test visibility
      "vercelAiGateway.logging.level": "debug",
    };
    fs.writeFileSync(
      path.join(userSettingsDir, "settings.json"),
      JSON.stringify(testSettings, null, 2),
    );
    console.log(`Created test settings: ${JSON.stringify(testSettings)}`);
  } else {
    console.log(
      "Using existing system settings (forensic capture should be enabled in your VS Code settings)",
    );
  }

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    ...(useSystemVscode ? { vscodeExecutablePath: systemVscodePath } : {}),
    launchArgs: [
      // CRITICAL: Use unique user-data-dir to avoid "another instance" error
      `--user-data-dir=${userDataDir}`,
      // NOTE: We do NOT disable extensions so Copilot can load
      // This allows testing real Copilot → our model flows
      // "--disable-extensions",
      // Open an empty workspace (no folder) to avoid trust prompts
      "--new-window",
      // Open the workspace folder so .github/agents are available
      extensionDevelopmentPath,
    ],
  });
}

main().catch((error: unknown) => {
  console.error("Failed to run integration tests", error);
  process.exit(1);
});
