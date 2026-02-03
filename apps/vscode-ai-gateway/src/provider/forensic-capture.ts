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
import { safeJsonStringify } from "../utils/serialize.js";

export interface FullContentCapture {
  systemPrompt?: string;
  messages: {
    role: string;
    name?: string;
    content: {
      type: "text" | "data" | "toolCall" | "toolResult" | "unknown";
      text?: string;
      mimeType?: string;
      dataSize?: number;
      toolName?: string;
      callId?: string;
      toolResult?: unknown;
      input?: unknown;
    }[];
  }[];
  tools?: {
    name: string;
    description?: string;
    inputSchema?: unknown;
  }[];
}

export interface ForensicCapture {
  // Metadata
  sequence: number;
  timestamp: string;
  captureVersion: "1.0" | "1.1";

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
    contentSummary: {
      index: number;
      role: string;
      partTypes: string[];
      textLength: number;
      hash: string;
    }[];
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

  // RAW options object - dump everything VS Code passes
  rawOptions: {
    allKeys: string[];
    fullDump: Record<string, unknown>;
  };

  // RAW model object - dump everything
  rawModel: {
    allKeys: string[];
    fullDump: Record<string, unknown>;
  };

  // RAW first message - check for hidden properties
  rawFirstMessage?: {
    allKeys: string[];
    role: unknown;
    name: unknown;
    content: unknown;
  };

  // RAW all messages - dump everything to find hidden identifiers
  rawAllMessages: {
    index: number;
    allKeys: string[];
    role: unknown;
    name: unknown;
    contentLength: number;
    extraProps: Record<string, unknown>;
  }[];

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

  // Full Content (only when forensicCaptureFullContent is enabled)
  fullContent?: FullContentCapture;
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
      const data = part.data;
      parts.push(`data:${part.mimeType}:${data.length.toString()}`);
    } else if ("callId" in part && "name" in part) {
      // Include tool call/result info - extract specific fields to avoid
      // circular references in VS Code's internal message structures
      const isResult = "toolResult" in part;
      let resultHash = "";
      if (isResult) {
        try {
          // Extract only the serializable fields we need
          const safeToolResult = {
            callId: part.callId,
            name: part.name,
            content:
              "content" in part
                ? String((part as { content?: unknown }).content)
                : undefined,
          };
          resultHash = hashContent(JSON.stringify(safeToolResult));
        } catch {
          resultHash = "unserializable";
        }
      }
      parts.push(
        `tool:${part.name}:${part.callId}${isResult ? `:${resultHash}` : ""}`,
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

function extractFullContent(
  input: CaptureInput,
): FullContentCapture | undefined {
  const config = vscode.workspace.getConfiguration("vercelAiGateway.debug");
  const captureFullContent = config.get<boolean>(
    "forensicCaptureFullContent",
    false,
  );

  if (!captureFullContent) {
    return undefined;
  }

  const messages: FullContentCapture["messages"] = input.chatMessages.map(
    (msg) => {
      const name = (msg as { name?: string }).name;
      const content = msg.content.map((part) => {
        if ("value" in part && typeof part.value === "string") {
          return { type: "text" as const, text: part.value };
        } else if ("data" in part && "mimeType" in part) {
          const data = part.data;
          return {
            type: "data" as const,
            mimeType: part.mimeType,
            dataSize: data.length,
          };
        } else if ("callId" in part && "name" in part) {
          const isResult = "toolResult" in part;
          if (isResult) {
            return {
              type: "toolResult" as const,
              toolName: part.name,
              callId: part.callId,
              toolResult: (part as { toolResult?: unknown }).toolResult,
            };
          } else {
            return {
              type: "toolCall" as const,
              toolName: part.name,
              callId: part.callId,
              input: (part as { input?: unknown }).input,
            };
          }
        } else {
          return { type: "unknown" as const };
        }
      });

      // Build result object, only including name if defined
      const result: FullContentCapture["messages"][number] = {
        role: ROLE_NAMES[msg.role as number] ?? `Unknown(${String(msg.role)})`,
        content,
      };
      if (name !== undefined) {
        result.name = name;
      }
      return result;
    },
  );

  // Build tools array, only including optional properties if defined
  const tools = input.options.tools?.map((t) => {
    const tool: NonNullable<FullContentCapture["tools"]>[number] = {
      name: t.name,
    };
    if (t.description !== undefined) {
      tool.description = t.description;
    }
    if (t.inputSchema !== undefined) {
      tool.inputSchema = t.inputSchema;
    }
    return tool;
  });

  const result: FullContentCapture = {
    messages,
  };
  if (input.systemPrompt !== undefined) {
    result.systemPrompt = input.systemPrompt;
  }
  if (tools !== undefined) {
    result.tools = tools;
  }
  return result;
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

    // Extract full content if enabled
    const fullContent = extractFullContent(input);

    const capture: ForensicCapture = {
      sequence: ++captureSequence,
      timestamp: new Date().toISOString(),
      captureVersion: fullContent ? "1.1" : "1.0",

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
        toolMode:
          typeof input.options.toolMode === "string"
            ? input.options.toolMode
            : "auto",
        modelOptions: input.options.modelOptions ?? {},
        toolSchemaHashes:
          input.options.tools?.map((t) => hashToolSchema(t)) ?? [],
      },

      // RAW dump of everything in options
      rawOptions: {
        allKeys: Object.keys(input.options),
        fullDump: Object.fromEntries(
          Object.entries(input.options).map(([key, value]) => {
            // For tools, just capture count and names (too large to dump fully)
            if (key === "tools" && Array.isArray(value)) {
              return [
                key,
                {
                  count: value.length,
                  names: value.map((t: { name: string }) => t.name),
                },
              ];
            }
            // For everything else, try to serialize
            try {
              return [key, JSON.parse(JSON.stringify(value))];
            } catch {
              return [key, `[unserializable: ${typeof value}]`];
            }
          }),
        ),
      },

      // RAW dump of model object
      rawModel: {
        allKeys: Object.keys(input.model),
        fullDump: Object.fromEntries(
          Object.entries(input.model).map(([key, value]) => {
            try {
              return [key, JSON.parse(JSON.stringify(value))];
            } catch {
              return [key, `[unserializable: ${typeof value}]`];
            }
          }),
        ),
      },

      // RAW dump of first message (if any)
      ...(input.chatMessages.length > 0
        ? {
            rawFirstMessage: {
              allKeys: Object.keys(input.chatMessages[0]!),
              role: input.chatMessages[0]!.role,
              // Capture the name field - this might contain participant/agent info
              name: (input.chatMessages[0] as { name?: unknown }).name,
              content: (() => {
                try {
                  // Just get structure, not full content
                  const msg = input.chatMessages[0]!;
                  return {
                    length: msg.content.length,
                    partTypes: msg.content.map((p) => {
                      const keys = Object.keys(p);
                      return { keys, type: typeof p };
                    }),
                  };
                } catch {
                  return "[error reading content]";
                }
              })(),
            },
          }
        : {}),

      // RAW dump of ALL messages (to find any hidden identifiers)
      rawAllMessages: input.chatMessages.map((msg, idx) => ({
        index: idx,
        allKeys: Object.keys(msg),
        role: msg.role,
        name: (msg as { name?: unknown }).name,
        contentLength: msg.content.length,
        // Dump any extra properties we might have missed
        extraProps: Object.fromEntries(
          Object.entries(msg)
            .filter(([k]) => !["content", "role", "c"].includes(k))
            .map(([k, v]) => {
              try {
                return [k, JSON.parse(JSON.stringify(v))];
              } catch {
                return [k, `[unserializable: ${typeof v}]`];
              }
            }),
        ),
      })),

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

      // Full content (only when forensicCaptureFullContent is enabled)
      ...(fullContent ? { fullContent } : {}),
    };

    // Write to JSONL file
    const outputDir = path.join(os.homedir(), ".vscode-ai-gateway");
    const outputFile = path.join(outputDir, "forensic-captures.jsonl");

    // Ensure directory exists
    await fs.promises.mkdir(outputDir, { recursive: true });

    // Append capture as JSON line (use safe stringify to handle any circular refs)
    const line = `${safeJsonStringify(capture)}\n`;
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
