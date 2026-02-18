import * as vscode from "vscode";
import type { ExtensionMessage } from "../webview/shared/message-types.js";
import type { InspectorData } from "../webview/shared/inspector-data.js";

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
    getData: () => Promise<InspectorData>,
    title: string,
  ): Promise<void> {
    this.currentUri = uri;
    const data = await getData();

    // Store pending content for ready handshake
    this.pendingContent = { data, title };

    if (this.panel) {
      // Panel exists — update content and reveal
      this.panel.title = title;
      this.sendContent(data);
      this.panel.reveal(vscode.ViewColumn.Beside, true);
    } else {
      // Create new panel
      // localResourceRoots includes webview dir (main.js + chunks/)
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

      // Listen for messages from webview
      this.panel.webview.onDidReceiveMessage(
        (message: { type: string; [key: string]: unknown }) => {
          if (message.type === "ready" && this.pendingContent) {
            this.sendContent(this.pendingContent.data);
          } else if (message.type === "open-file") {
            void this.openFile(
              message as {
                type: "open-file";
                absolutePath: string;
                startLine?: number;
                endLine?: number;
              },
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
  private pendingContent: { data: InspectorData; title: string } | undefined;

  /**
   * Send structured data to the webview via postMessage.
   */
  private sendContent(data: InspectorData): void {
    if (!this.panel) return;

    const message: ExtensionMessage = {
      type: "update",
      data,
    };
    void this.panel.webview.postMessage(message);
  }

  /**
   * Refresh the current content if the panel is showing the given URI.
   */
  async refresh(
    uri: vscode.Uri,
    getData: () => Promise<InspectorData>,
  ): Promise<void> {
    if (
      this.panel &&
      this.currentUri &&
      this.currentUri.toString() === uri.toString()
    ) {
      const data = await getData();
      this.sendContent(data);
    }
  }

  /**
   * Refresh the current content using a data resolver function.
   * Call this when the underlying data may have changed (e.g., tool results added).
   */
  async refreshCurrent(
    getDataForUri: (uri: vscode.Uri) => InspectorData,
  ): Promise<void> {
    if (this.panel && this.currentUri) {
      const data = getDataForUri(this.currentUri);
      this.sendContent(data);
    }
  }

  /**
   * Get the current URI being displayed, if any.
   */
  getCurrentUri(): vscode.Uri | undefined {
    return this.currentUri;
  }

  /**
   * Check if the panel is currently visible.
   */
  isVisible(): boolean {
    return this.panel?.visible ?? false;
  }

  /**
   * Open a file in the editor at the specified location.
   */
  private async openFile(message: {
    absolutePath: string;
    startLine?: number;
    endLine?: number;
  }): Promise<void> {
    const uri = vscode.Uri.file(message.absolutePath);
    const doc = await vscode.workspace.openTextDocument(uri);

    if (message.startLine !== undefined) {
      const startLine = Math.max(0, message.startLine - 1); // Convert to 0-based
      const endLine =
        message.endLine !== undefined
          ? Math.max(0, message.endLine - 1)
          : startLine;
      const selection = new vscode.Selection(startLine, 0, endLine, 0);
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.One,
        selection,
        preserveFocus: false,
      });
    } else {
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
      });
    }
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
   * Uses ES modules to support Vite code splitting for lazy language loading.
   */
  private getHtml(webview: vscode.Webview): string {
    // Get URI for the webview script
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "out", "webview", "main.js"),
    );

    // No CSP — VS Code webviews have their own security model
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Inspector</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
