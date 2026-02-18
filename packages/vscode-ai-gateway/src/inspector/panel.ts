import * as vscode from "vscode";

/**
 * Singleton inspector panel that reuses the same webview.
 *
 * Default click opens in this shared panel. Right-click "Open in New Window"
 * can open a separate markdown preview if needed.
 */
export class InspectorPanel {
  private static instance: InspectorPanel | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private currentUri: vscode.Uri | undefined;
  private disposables: vscode.Disposable[] = [];

  private constructor(_extensionUri: vscode.Uri) {}

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

    if (this.panel) {
      // Panel exists — update content and reveal
      this.panel.title = title;
      const markdown = await getContent();
      this.panel.webview.html = this.getHtml(markdown, title);
      this.panel.reveal(vscode.ViewColumn.Beside, true);
    } else {
      // Create new panel
      this.panel = vscode.window.createWebviewPanel(
        "vercel.ai.inspector",
        title,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        {
          enableScripts: false,
          localResourceRoots: [],
        },
      );

      const markdown = await getContent();
      this.panel.webview.html = this.getHtml(markdown, title);

      // Handle panel disposal
      this.panel.onDidDispose(
        () => {
          this.panel = undefined;
          this.currentUri = undefined;
        },
        null,
        this.disposables,
      );
    }
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
      const markdown = await getContent();
      this.panel.webview.html = this.getHtml(markdown, title);
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
   * Generate HTML for the webview with rendered markdown.
   *
   * Note: Currently renders markdown as preformatted text.
   * Will be replaced with Svelte-based rendering (RFC 00074).
   */
  private getHtml(markdown: string, title: string): string {
    // Escape HTML and preserve formatting
    // Svelte webview (RFC 00074) will add proper markdown rendering
    const html = `<pre style="white-space: pre-wrap; word-wrap: break-word; font-family: inherit;">${this.escapeHtml(markdown)}</pre>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <title>${this.escapeHtml(title)}</title>
  <style>
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      line-height: 1.6;
      color: var(--vscode-foreground, #cccccc);
      background-color: var(--vscode-editor-background, #1e1e1e);
      padding: 16px;
      max-width: 900px;
      margin: 0 auto;
    }
    h1, h2, h3, h4, h5, h6 {
      color: var(--vscode-foreground, #cccccc);
      border-bottom: 1px solid var(--vscode-panel-border, #454545);
      padding-bottom: 0.3em;
      margin-top: 1.5em;
      margin-bottom: 0.5em;
    }
    h1 { font-size: 1.8em; }
    h2 { font-size: 1.4em; }
    h3 { font-size: 1.2em; }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 1em 0;
    }
    th, td {
      border: 1px solid var(--vscode-panel-border, #454545);
      padding: 8px 12px;
      text-align: left;
    }
    th {
      background-color: var(--vscode-editor-inactiveSelectionBackground, #3a3d41);
    }
    code {
      font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
      background-color: var(--vscode-textCodeBlock-background, #2d2d2d);
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 0.9em;
    }
    pre {
      background-color: var(--vscode-textCodeBlock-background, #2d2d2d);
      padding: 16px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 1em 0;
    }
    pre code {
      background: none;
      padding: 0;
    }
    a {
      color: var(--vscode-textLink-foreground, #3794ff);
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
    blockquote {
      border-left: 4px solid var(--vscode-textBlockQuote-border, #007acc);
      margin: 1em 0;
      padding: 0.5em 1em;
      background-color: var(--vscode-textBlockQuote-background, #2d2d2d);
    }
    ul, ol {
      padding-left: 2em;
    }
    li {
      margin: 0.25em 0;
    }
  </style>
</head>
<body>
  ${html}
</body>
</html>`;
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}
