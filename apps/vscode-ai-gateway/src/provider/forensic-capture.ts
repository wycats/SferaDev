/**
 * Forensic Capture Module
 *
 * Captures detailed request data for debugging and analysis.
 * Enable via setting: vercelAiGateway.debug.forensicCapture
 * Output: ~/.vscode-ai-gateway/forensic-captures.jsonl
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import * as vscode from "vscode";
import type {
  LanguageModelChatInformation,
  LanguageModelChatMessage,
} from "vscode";
import { logger } from "../logger";

export interface ForensicCapture {
  // Metadata
  sequence: number;
  timestamp: string;
  captureVersion: "1.0";

  // VS Code Environment - capture EVERYTHING available
  vscodeEnv: {
    sessionId: string;
    machineId: string;
    appName: string;
    appHost: string;
    uiKind: "Desktop" | "Web";
    language: string;
    remoteName?: string;
    appRoot: string;
    isNewAppInstall: boolean;
    isTelemetryEnabled: boolean;
  };

  // Model Information
  model: {
    id: string;
    family: string;
    name: string;
    version: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    capabilities: Record<string, unknown>;
  };

  // Messages (sanitized - hashes only, no content)
  messages: {
    count: number;
    roles: string[];
    contentSummary: Array<{
      index: number;
      role: string;
      partTypes: string[];
      textLength: number;
      hash: string;
    }>;
  };

  // System Prompt Analysis (hash only for privacy)
  systemPrompt?: {
    detected: boolean;
    length: number;
    hash: string;
    // No preview - privacy sensitive
  };

  // Options passed to provider
  options: {
    toolCount: number;
    toolNames: string[];
    toolMode: string;
    modelOptions: Record<string, unknown>;
    // Tool schema hashes for identifier discovery
    toolSchemaHashes: string[];
  };

  // Token Estimation
  tokens: {
    estimated: number;
    maxInput: number;
    percentUsed: number;
  };

  // Internal State
  internalState: {
    chatId: string;
    currentAgentId: string | null;
    hasActiveStreaming: boolean;
  };
}

// Global sequence counter
let captureSequence = 0;

// Role number to string mapping
const ROLE_NAMES: Record<number, string> = {
  1: "User",
  2: "Assistant",
  3: "System",
};

export interface CaptureInput {
  model: LanguageModelChatInformation;
  chatMessages: readonly LanguageModelChatMessage[];
  options: {
    tools?: readonly {
      name: string;
      description?: string;
      inputSchema?: unknown;
    }[];
    toolMode?: unknown;
    modelOptions?: Record<string, unknown>;
  };
  systemPrompt: string | undefined;
  systemPromptHash: string | undefined;
  estimatedTokens: number;
  chatId: string;
  currentAgentId: string | null;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").substring(0, 16);
}

function getMessageTextLength(message: LanguageModelChatMessage): number {
  let length = 0;
  for (const part of message.content) {
    if ("value" in part && typeof part.value === "string") {
      length += part.value.length;
    }
  }
  return length;
}

function getPartTypes(message: LanguageModelChatMessage): string[] {
  const types: string[] = [];
  for (const part of message.content) {
    if ("value" in part && typeof part.value === "string") {
      types.push("text");
    } else if ("data" in part && "mimeType" in part) {
      types.push("data");
    } else if ("callId" in part && "name" in part) {
      types.push("toolResult" in part ? "toolResult" : "toolCall");
    } else {
      types.push("unknown");
    }
  }
  return types;
}

function getMessageHash(message: LanguageModelChatMessage): string {
  const parts: string[] = [];
  for (const part of message.content) {
    if ("value" in part && typeof part.value === "string") {
      // Hash text content
      parts.push(`text:${hashContent(part.value)}`);
    } else if ("data" in part && "mimeType" in part) {
      // Hash data parts by mimeType and size
      const data = part.data as Uint8Array;
      parts.push(`data:${String(part.mimeType)}:${data.length.toString()}`);
    } else if ("callId" in part && "name" in part) {
      // Include tool call/result info
      const isResult = "toolResult" in part;
      const resultHash = isResult ? hashContent(JSON.stringify(part)) : "";
      parts.push(
        `tool:${String(part.name)}:${String(part.callId)}${isResult ? `:${resultHash}` : ""}`,
      );
    }
  }
  return hashContent(parts.join("|"));
}

function hashToolSchema(tool: {
  name: string;
  description?: string;
  inputSchema?: unknown;
}): string {
  const content = JSON.stringify({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  });
  return hashContent(content);
}

export async function captureForensicData(input: CaptureInput): Promise<void> {
  try {
    const remoteName = vscode.env.remoteName;

    const systemPromptData = input.systemPrompt
      ? {
          detected: true,
          length: input.systemPrompt.length,
          hash: input.systemPromptHash ?? hashContent(input.systemPrompt),
          // No preview stored for privacy
        }
      : undefined;

    const capture: ForensicCapture = {
      sequence: ++captureSequence,
      timestamp: new Date().toISOString(),
      captureVersion: "1.0",

      vscodeEnv: {
        sessionId: vscode.env.sessionId,
        machineId: vscode.env.machineId,
        appName: vscode.env.appName,
        appHost: vscode.env.appHost,
        uiKind: vscode.env.uiKind === vscode.UIKind.Desktop ? "Desktop" : "Web",
        language: vscode.env.language,
        ...(remoteName ? { remoteName } : {}),
        appRoot: vscode.env.appRoot,
        isNewAppInstall: vscode.env.isNewAppInstall,
        isTelemetryEnabled: vscode.env.isTelemetryEnabled,
      },

      model: {
        id: input.model.id,
        family: input.model.family,
        name: input.model.name,
        version: input.model.version,
        maxInputTokens: input.model.maxInputTokens,
        maxOutputTokens: input.model.maxOutputTokens,
        capabilities: { ...input.model.capabilities },
      },

      messages: {
        count: input.chatMessages.length,
        roles: input.chatMessages.map(
          (m) => ROLE_NAMES[m.role as number] ?? `Unknown(${String(m.role)})`,
        ),
        contentSummary: input.chatMessages.map((m, i) => ({
          index: i,
          role: ROLE_NAMES[m.role as number] ?? `Unknown(${String(m.role)})`,
          partTypes: getPartTypes(m),
          textLength: getMessageTextLength(m),
          hash: getMessageHash(m),
        })),
      },

      ...(systemPromptData ? { systemPrompt: systemPromptData } : {}),

      options: {
        toolCount: input.options.tools?.length ?? 0,
        toolNames: input.options.tools?.map((t) => t.name) ?? [],
        toolMode: String(input.options.toolMode ?? "auto"),
        modelOptions: input.options.modelOptions ?? {},
        toolSchemaHashes:
          input.options.tools?.map((t) => hashToolSchema(t)) ?? [],
      },

      tokens: {
        estimated: input.estimatedTokens,
        maxInput: input.model.maxInputTokens,
        percentUsed:
          input.model.maxInputTokens > 0
            ? Math.round(
                (input.estimatedTokens / input.model.maxInputTokens) * 100,
              )
            : 0,
      },

      internalState: {
        chatId: input.chatId,
        currentAgentId: input.currentAgentId,
        hasActiveStreaming: input.currentAgentId !== null,
      },
    };

    // Write to JSONL file
    const outputDir = path.join(os.homedir(), ".vscode-ai-gateway");
    const outputFile = path.join(outputDir, "forensic-captures.jsonl");

    // Ensure directory exists
    await fs.promises.mkdir(outputDir, { recursive: true });

    // Append capture as JSON line
    const line = `${JSON.stringify(capture)}\n`;
    await fs.promises.appendFile(outputFile, line, "utf-8");

    logger.info(
      `[Forensic] Captured request #${capture.sequence.toString()} to ${outputFile}`,
    );
  } catch (error) {
    logger.error(`[Forensic] Failed to capture data: ${String(error)}`);
  }
}

export function clearForensicCaptures(): void {
  captureSequence = 0;
  const outputFile = path.join(
    os.homedir(),
    ".vscode-ai-gateway",
    "forensic-captures.jsonl",
  );
  try {
    fs.unlinkSync(outputFile);
    logger.info("[Forensic] Cleared capture file");
  } catch {
    // File may not exist
  }
}
