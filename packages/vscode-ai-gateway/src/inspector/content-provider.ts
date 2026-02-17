import * as vscode from "vscode";
import type {
  ActivityLogEntry,
  AIResponseEntry,
  CompactionEntry,
  Conversation,
  ErrorEntry,
  Subagent,
  UserMessageEntry,
} from "@vercel/conversation";
import type { TurnEntry } from "../conversation/types.js";
import { buildTree } from "@vercel/conversation";
import {
  renderAIResponse,
  renderCompaction,
  renderConversation,
  renderError,
  renderHistory,
  renderSubagent,
  renderToolContinuation,
  renderTurn,
  renderUserMessage,
} from "./render.js";

export const INSPECTOR_SCHEME = "vercel-ai-inspector";

export interface InspectorTarget {
  conversationId: string;
  entryType: string;
  identifier?: string;
}

export function parseInspectorUri(uri: vscode.Uri): InspectorTarget | null {
  if (uri.scheme !== INSPECTOR_SCHEME) return null;

  const segments = uri.path.split("/").filter(Boolean);
  if (segments.length < 2) return null;

  const conversationId = decodeURIComponent(segments[0] ?? "");
  const entryType = decodeURIComponent(segments[1] ?? "");
  const identifier = segments[2] ? decodeURIComponent(segments[2]) : undefined;

  if (!conversationId || !entryType) return null;

  if (identifier === undefined) {
    return { conversationId, entryType };
  }

  return { conversationId, entryType, identifier };
}

export class InspectorContentProvider
  implements vscode.TextDocumentContentProvider
{
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;
  private openUris = new Set<string>();

  constructor(private readonly getConversations: () => Conversation[]) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    this.openUris.add(uri.toString());

    const parsed = parseInspectorUri(uri);
    if (!parsed) {
      return "Not found";
    }

    const conversation = this.getConversations().find(
      (entry) => entry.id === parsed.conversationId,
    );
    if (!conversation) {
      return "Not found";
    }

    switch (parsed.entryType) {
      case "conversation":
        return renderConversation(conversation);
      case "history": {
        const historyEntries = buildTree(
          conversation.activityLog,
        ).historyEntries;
        return renderHistory(historyEntries, conversation);
      }
      case "user-message": {
        const entry =
          parsed.identifier === undefined
            ? undefined
            : findUserMessage(conversation.activityLog, parsed.identifier);
        return entry ? renderUserMessage(entry, conversation) : "Not found";
      }
      case "tool-continuation": {
        const match =
          parsed.identifier === undefined
            ? undefined
            : findToolContinuation(conversation.activityLog, parsed.identifier);
        return match
          ? renderToolContinuation(match.entry, match.tools, conversation)
          : "Not found";
      }
      case "ai-response": {
        const entry =
          parsed.identifier === undefined
            ? undefined
            : findAIResponse(conversation.activityLog, parsed.identifier);
        return entry ? renderAIResponse(entry, conversation) : "Not found";
      }
      case "compaction": {
        const entry =
          parsed.identifier === undefined
            ? undefined
            : findCompaction(conversation.activityLog, parsed.identifier);
        return entry ? renderCompaction(entry, conversation) : "Not found";
      }
      case "error": {
        const entry =
          parsed.identifier === undefined
            ? undefined
            : findError(conversation.activityLog, parsed.identifier);
        return entry ? renderError(entry, conversation) : "Not found";
      }
      case "subagent": {
        const entry =
          parsed.identifier === undefined
            ? undefined
            : findSubagent(conversation.subagents, parsed.identifier);
        return entry ? renderSubagent(entry, conversation) : "Not found";
      }
      case "turn": {
        const entry =
          parsed.identifier === undefined
            ? undefined
            : findTurn(conversation.activityLog, parsed.identifier);
        return entry ? renderTurn(entry, conversation) : "Not found";
      }
      default:
        return "Not found";
    }
  }

  /** Call when conversations change to refresh open inspector documents */
  refresh(): void {
    for (const uri of this.openUris) {
      this._onDidChange.fire(vscode.Uri.parse(uri));
    }
  }

  dispose(): void {
    this.openUris.clear();
    this._onDidChange.dispose();
  }
}

function parseNumberIdentifier(identifier?: string): number | null {
  if (!identifier) return null;
  const value = Number(identifier);
  return Number.isFinite(value) ? value : null;
}

function findUserMessage(
  log: ActivityLogEntry[],
  identifier?: string,
): UserMessageEntry | undefined {
  const sequenceNumber = parseNumberIdentifier(identifier);
  if (sequenceNumber == null) return undefined;

  return log.find(
    (entry): entry is UserMessageEntry =>
      entry.type === "user-message" &&
      !entry.isToolContinuation &&
      entry.sequenceNumber === sequenceNumber,
  );
}

function findAIResponse(
  log: ActivityLogEntry[],
  identifier?: string,
): AIResponseEntry | undefined {
  const sequenceNumber = parseNumberIdentifier(identifier);
  if (sequenceNumber == null) return undefined;

  return log.find(
    (entry): entry is AIResponseEntry =>
      entry.type === "ai-response" && entry.sequenceNumber === sequenceNumber,
  );
}

function findToolContinuation(
  log: ActivityLogEntry[],
  identifier?: string,
): { entry: UserMessageEntry; tools: string[] } | undefined {
  const sequenceNumber = parseNumberIdentifier(identifier);
  if (sequenceNumber == null) return undefined;

  const toolIndex = log.findIndex(
    (entry): entry is UserMessageEntry =>
      entry.type === "user-message" &&
      entry.isToolContinuation === true &&
      entry.sequenceNumber === sequenceNumber,
  );
  if (toolIndex < 0) return undefined;

  let tools: string[] = [];
  for (let i = toolIndex - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry?.type === "ai-response") {
      tools = entry.toolsUsed ?? [];
      break;
    }
  }

  const toolEntry = log[toolIndex];
  if (!toolEntry || toolEntry.type !== "user-message") return undefined;
  return { entry: toolEntry, tools };
}

function findCompaction(
  log: ActivityLogEntry[],
  identifier?: string,
): CompactionEntry | undefined {
  const turnNumber = parseNumberIdentifier(identifier);
  if (turnNumber == null) return undefined;

  return log.find(
    (entry): entry is CompactionEntry =>
      entry.type === "compaction" && entry.turnNumber === turnNumber,
  );
}

function findError(
  log: ActivityLogEntry[],
  identifier?: string,
): ErrorEntry | undefined {
  const value = parseNumberIdentifier(identifier);
  if (value == null) return undefined;

  return log.find(
    (entry): entry is ErrorEntry =>
      entry.type === "error" &&
      (entry.turnNumber === value ||
        (entry.turnNumber == null && entry.timestamp === value)),
  );
}

function findTurn(
  log: ActivityLogEntry[],
  identifier?: string,
): TurnEntry | undefined {
  const turnNumber = parseNumberIdentifier(identifier);
  if (turnNumber == null) return undefined;

  for (const entry of log as Array<ActivityLogEntry | TurnEntry>) {
    if (entry.type === "turn" && entry.turnNumber === turnNumber) {
      return entry;
    }
  }

  return undefined;
}

function findSubagent(
  subagents: Subagent[],
  identifier?: string,
): Subagent | undefined {
  if (!identifier) return undefined;

  for (const subagent of subagents) {
    if (subagent.conversationId === identifier) {
      return subagent;
    }
    const child = findSubagent(subagent.children, identifier);
    if (child) return child;
  }

  return undefined;
}
