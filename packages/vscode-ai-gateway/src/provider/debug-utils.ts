import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CreateResponseBody } from "openresponses-client";
import * as vscode from "vscode";
import { logger } from "../logger.js";

export interface SuspiciousRequestContext {
  timestamp: string;
  finishReason: string | undefined;
  textPartCount: number;
  toolCallCount: number;
  toolsProvided: number;
  textPreview: string;
  usage: { input_tokens: number; output_tokens: number } | undefined;
}

/**
 * Save a suspicious request for replay with the test script.
 * This is called when we detect a premature stop pattern (text but no tool calls).
 */
export function saveSuspiciousRequest(
  requestBody: CreateResponseBody,
  context: SuspiciousRequestContext,
): void {
  try {
    const config = vscode.workspace.getConfiguration("vercel.ai");
    const forensicEnabled = config.get<boolean>("debug.forensicCapture", false);

    if (!forensicEnabled) {
      logger.debug(
        "[OpenResponses] Skipping suspicious request capture (forensicCapture disabled)",
      );
      return;
    }

    // Find workspace root by looking for package.json
    const workspaceRoot = process.cwd();
    const logsDir = resolve(workspaceRoot, ".logs");

    // Ensure logs directory exists
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }

    const filePath = resolve(logsDir, "last-suspicious-request.json");
    const data = {
      request: requestBody,
      context,
    };

    writeFileSync(filePath, JSON.stringify(data, null, 2));
    logger.info(
      `[OpenResponses] Saved suspicious request to ${filePath} for replay`,
    );
  } catch (err) {
    logger.warn(
      `[OpenResponses] Failed to save suspicious request: ${String(err)}`,
    );
  }
}
