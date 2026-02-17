import * as vscode from "vscode";
import { INSPECTOR_SCHEME } from "./content-provider.js";

/**
 * Build an inspector URI for a tree node.
 *
 * @param conversationId - The conversation ID
 * @param entryType - The type of entry (e.g., "ai-response", "tool-call")
 * @param identifier - Optional sequence number or turn number
 * @param subIdentifier - Optional sub-identifier (e.g., callId for tool calls)
 */
export function inspectorUri(
  conversationId: string,
  entryType: string,
  identifier?: string | number,
  subIdentifier?: string,
): vscode.Uri {
  const encodedConversationId = encodeURIComponent(conversationId);
  const encodedEntryType = encodeURIComponent(entryType);
  const encodedIdentifier =
    identifier === undefined
      ? ""
      : `/${encodeURIComponent(identifier.toString())}`;
  const encodedSubIdentifier =
    subIdentifier === undefined
      ? ""
      : `/${encodeURIComponent(subIdentifier)}`;

  return vscode.Uri.parse(
    `${INSPECTOR_SCHEME}://inspect/${encodedConversationId}/${encodedEntryType}${encodedIdentifier}${encodedSubIdentifier}`,
  );
}
