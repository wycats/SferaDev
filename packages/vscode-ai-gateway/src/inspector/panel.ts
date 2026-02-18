import * as vscode from "vscode";
import type { ExtensionMessage } from "../webview/shared/message-types.js";

/**
 * Singleton inspector panel that reuses the same webview.
 *
 * Default click opens in this shared panel. Right-click "Open in New Window"
 * can open a separate markdown preview if needed.
 *
 * Uses a Svelte-based webview for rendering (RFC 00074).
 */
export class InspectorPanel {
  private static instance: InspectorPanel | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private currentUri: vscode.Uri | undefined;
  private disposables: vscode.Disposable[] = [];
  private readonly extensionUri: vscode.Uri;

  private constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
  }

  /**
   * Get or create the singleton inspector panel.
   */
  static getInstance(extensionUri: vscode.Uri): InspectorPanel {
    if (!InspectorPanel.instance) {
      InspectorPanel.instance = new InspectorPanel(extensionUri);
    }
    return InspectorPanel.instance;
  }

  /**
   * Show content in the inspector panel.
   * Creates the panel if it doesn't exist, or reveals and updates it if it does.
   */
  async show(
    uri: vscode.Uri,
    getContent: () => Promise<string>,
    title: string,
  ): Promise<void> {
    this.currentUri = uri;
    const content = await getContent();

    // Store pending content for ready handshake
    this.pendingContent = { content, title };

    if (this.panel) {
      // Panel exists — update content and reveal
      this.panel.title = title;
      this.sendContent(content, title);
      this.panel.reveal(vscode.ViewColumn.Beside, true);
    } else {
      // Create new panel
      this.panel = vscode.window.createWebviewPanel(
        "vercel.ai.inspector",
        title,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        {
          enableScripts: true,
          localResourceRoots: [
            vscode.Uri.joinPath(this.extensionUri, "out", "webview"),
          ],
        },
      );

      this.panel.webview.html = this.getHtml(this.panel.webview);

      // Listen for ready message from webview
      this.panel.webview.onDidReceiveMessage(
        (message: { type: string }) => {
          if (message.type === "ready" && this.pendingContent) {
            this.sendContent(
              this.pendingContent.content,
              this.pendingContent.title,
            );
          }
        },
        null,
        this.disposables,
      );

      // Handle panel disposal
      this.panel.onDidDispose(
        () => {
          this.panel = undefined;
          this.currentUri = undefined;
          this.pendingContent = undefined;
        },
        null,
        this.disposables,
      );
    }
  }

  // Pending content for ready handshake
  private pendingContent: { content: string; title: string } | undefined;

  /**
   * Send content to the webview via postMessage.
   */
  private sendContent(content: string, title: string): void {
    if (!this.panel) return;

    const message: ExtensionMessage = {
      type: "update",
      content,
      title,
    };
    void this.panel.webview.postMessage(message);
  }

  /**
   * Refresh the current content if the panel is showing the given URI.
   */
  async refresh(
    uri: vscode.Uri,
    getContent: () => Promise<string>,
    title: string,
  ): Promise<void> {
    if (
      this.panel &&
      this.currentUri &&
      this.currentUri.toString() === uri.toString()
    ) {
      const content = await getContent();
      this.sendContent(content, title);
    }
  }

  /**
   * Check if the panel is currently visible.
   */
  isVisible(): boolean {
    return this.panel?.visible ?? false;
  }

  /**
   * Dispose the panel and clean up resources.
   */
  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.currentUri = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    InspectorPanel.instance = undefined;
  }

  /**
   * Generate HTML shell for the Svelte webview.
   *
   * The actual content is sent via postMessage after the webview loads.
   */
  private getHtml(webview: vscode.Webview): string {
    // Generate nonce for CSP
    const nonce = this.getNonce();

    // Get URI for the webview script
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "out", "webview", "main.js"),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Inspector</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  /**
   * Generate a random nonce for CSP.
   */
  private getNonce(): string {
    let text = "";
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
