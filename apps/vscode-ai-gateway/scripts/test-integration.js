#!/usr/bin/env node
/**
 * Integration test wrapper script.
 *
 * This script handles:
 * 1. xvfb-run on Linux for headless execution
 * 2. Environment isolation (clears Wayland vars)
 * 3. Sets VSCODE_TEST_WRAPPER=true to prevent direct runTest.ts execution
 *
 * Usage:
 *   pnpm test:integration          # Headless (uses xvfb on Linux)
 *   pnpm test:integration --headed # Opens visible VS Code window
 */

import { spawn, execSync } from "child_process";
import * as fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveXvfbRun() {
  // Allow override via environment variable
  const envOverride = process.env.XVFB_RUN ?? "";
  if (envOverride.trim().length > 0 && fs.existsSync(envOverride)) {
    return envOverride.trim();
  }

  // Try to find xvfb-run in PATH
  try {
    const resolved = execSync("command -v xvfb-run", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (resolved.length > 0) {
      return resolved;
    }
  } catch {
    // ignore - xvfb-run not found
  }

  // Fallback to common locations
  const fallbacks = [
    "/usr/bin/xvfb-run",
    "/run/host/usr/bin/xvfb-run", // Fedora Silverblue/Bazzite (immutable distros)
  ];

  for (const fallback of fallbacks) {
    if (fs.existsSync(fallback)) {
      return fallback;
    }
  }

  return null;
}

async function run() {
  const args = process.argv.slice(2);
  const isLinux = process.platform === "linux";
  const isHeaded = args.includes("--headed");
  const filteredArgs = args.filter((a) => a !== "--headed");

  const scriptPath = path.resolve(__dirname, "../out/test/runTest.js");

  // Check if compiled output exists
  if (!fs.existsSync(scriptPath)) {
    console.error("ERROR: Test runner not compiled.");
    console.error("Run 'pnpm compile' first.");
    process.exit(1);
  }

  let command = "node";
  let commandArgs = [scriptPath, ...filteredArgs];

  const env = {
    ...process.env,
    VSCODE_TEST_WRAPPER: "true",
  };

  if (isLinux && !isHeaded) {
    const xvfbRun = resolveXvfbRun();
    if (xvfbRun) {
      console.log(`Using xvfb-run: ${xvfbRun}`);

      // Prevent Wayland leakage; force X11/Xvfb
      delete env.WAYLAND_DISPLAY;
      delete env.DISPLAY;
      if (env.XDG_SESSION_TYPE === "wayland") {
        delete env.XDG_SESSION_TYPE;
      }

      command = xvfbRun;
      commandArgs = [
        "--auto-servernum",
        "--server-args=-screen 0 1280x1024x24 -nolisten tcp",
        "--",
        "node",
        scriptPath,
        ...filteredArgs,
      ];
    } else {
      console.warn(
        "WARNING: xvfb-run not found. Tests may fail without a display.",
      );
      console.warn("Install xvfb: sudo apt install xvfb (Debian/Ubuntu)");
      console.warn("Or run with --headed flag to use visible window.");
    }
  }

  if (isHeaded) {
    console.log("Running in headed mode (visible VS Code window)");
  }

  const testProcess = spawn(command, commandArgs, {
    stdio: "inherit",
    shell: false,
    env,
  });

  testProcess.on("error", (err) => {
    console.error("Failed to start test process:", err.message);
    process.exit(1);
  });

  testProcess.on("close", (code) => {
    process.exit(code ?? 0);
  });
}

run();
