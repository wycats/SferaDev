import * as vscode from "vscode"
import { INSPECTOR_SCHEME } from "./content-provider.js"

export function inspectorUri(
  conversationId: string,
  entryType: string,
  identifier?: string | number,
): vscode.Uri {
  const encodedConversationId = encodeURIComponent(conversationId);
  const encodedEntryType = encodeURIComponent(entryType);
  const encodedIdentifier =
    identifier === undefined
      ? ""
      : `/${encodeURIComponent(identifier.toString())}`;

  return vscode.Uri.parse(
    `${INSPECTOR_SCHEME}://inspect/${encodedConversationId}/${encodedEntryType}${encodedIdentifier}`,
  );
}
