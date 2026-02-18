---
title: Svelte Webview Infrastructure
stage: 0
feature: webview-infrastructure
exo:
  tool: exo rfc create
  protocol: 1
---

# RFC 00074: Svelte Webview Infrastructure

**Status:** Stage 0 (Draft)  
**Created:** 2026-02-17  
**Related:** Inspector panel work (current branch)

## Summary

Introduce a Svelte-based webview infrastructure for rich UI panels in the extension, starting with the inspector panel. Use `esbuild-svelte` to keep a single build system, and `@vscode-elements/elements` for native VS Code styling.

## Motivation

### Current State

The inspector panel uses a singleton `WebviewPanel` that renders content from a `TextDocumentContentProvider`. This addresses the "multiple windows" problem, but the current approach still has limitations:

1. **No markdown rendering** — Content displays as escaped preformatted text (no formatting, syntax highlighting, or structure)
2. **No state** — Can't remember scroll position, expanded sections, or user preferences
3. **Limited extensibility** — Adding features requires manual DOM manipulation

### Why Webviews

VS Code webviews provide:

- **Single panel reuse** — `reveal()` brings existing panel to front
- **Full HTML/CSS/JS** — Rich, interactive UI
- **Message passing** — Extension ↔ webview communication
- **State persistence** — `getState()`/`setState()` survive panel hide/show
- **Theming** — CSS variables match current VS Code theme

### Why Svelte

1. **Compiles away** — No runtime overhead; outputs vanilla JS
2. **Reactive** — Declarative UI updates without manual DOM manipulation
3. **Small bundles** — Typically smaller than React/Vue equivalents
4. **Simple mental model** — `.svelte` files are enhanced HTML
5. **Works with web components** — Can use `@vscode-elements/elements` directly

### Why Not Vite?

We already use esbuild. Adding Vite would mean:

- Two build systems to maintain
- Separate dev server configuration
- More dependencies

The `esbuild-svelte` plugin integrates cleanly with our existing build.

## Design

### Directory Structure

```
packages/vscode-ai-gateway/
├── src/
│   ├── extension.ts
│   ├── webview/                    # NEW: All webview apps
│   │   ├── shared/                 # Shared utilities
│   │   │   ├── vscode-api.ts       # acquireVsCodeApi() wrapper
│   │   │   ├── theme.ts            # Theme detection utilities
│   │   │   └── message-types.ts    # Type-safe message definitions
│   │   └── inspector/              # Inspector webview app
│   │       ├── main.ts             # Entry point
│   │       ├── App.svelte          # Root component
│   │       └── components/
│   │           ├── MarkdownContent.svelte
│   │           ├── JsonViewer.svelte
│   │           └── ToolCallCard.svelte
│   └── inspector/
│       ├── panel.ts                # WebviewPanel manager (extension side)
│       ├── render.ts               # Content extraction (existing)
│       └── uri.ts                  # URI parsing (existing)
```

**Rationale for `src/webview/`:**

- Clear separation: webview code runs in browser context, not Node
- Supports multiple webviews: `webview/inspector/`, `webview/settings/`, etc.
- Shared code lives in `webview/shared/`
- Intuitive location: "where would I look for webview code?"

### Build Configuration

Add a second esbuild entry point for webview bundles:

```typescript
// esbuild.config.ts (conceptual)
const extensionBuild = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  platform: "node",
  external: ["vscode"],
  // ... existing config
};

const webviewBuild = {
  entryPoints: ["src/webview/inspector/main.ts"],
  outdir: "dist/webview",
  platform: "browser",
  format: "iife",
  plugins: [sveltePlugin()],
  // ... webview-specific config
};
```

The webview bundle outputs to `dist/webview/inspector.js`.

### Dependencies

```json
{
  "devDependencies": {
    "svelte": "^5.x",
    "esbuild-svelte": "^0.9.x"
  },
  "dependencies": {
    "@vscode-elements/elements": "^2.x"
  }
}
```

Note: `@vscode-elements/elements` is a runtime dependency (web components loaded in webview).

### WebviewPanel Manager

```typescript
// src/inspector/panel.ts
export class InspectorPanel {
  private static instance: InspectorPanel | undefined;
  private panel: vscode.WebviewPanel | undefined;

  static getInstance(extensionUri: vscode.Uri): InspectorPanel {
    if (!InspectorPanel.instance) {
      InspectorPanel.instance = new InspectorPanel(extensionUri);
    }
    return InspectorPanel.instance;
  }

  async show(data: InspectorData): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        "vercel.ai.inspector",
        "Inspector",
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        {
          enableScripts: true,
          localResourceRoots: [
            vscode.Uri.joinPath(this.extensionUri, "dist", "webview"),
          ],
        },
      );
      this.panel.webview.html = this.getHtml();
      this.panel.onDidDispose(() => (this.panel = undefined));
    }

    // Send data to webview
    this.panel.webview.postMessage({ type: "update", data });
  }

  private getHtml(): string {
    const scriptUri = this.panel!.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "inspector.js"),
    );

    return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" 
              content="default-src 'none'; script-src ${this.panel!.webview.cspSource}; style-src ${this.panel!.webview.cspSource} 'unsafe-inline';">
      </head>
      <body>
        <div id="app"></div>
        <script src="${scriptUri}"></script>
      </body>
      </html>`;
  }
}
```

### Svelte App Structure

```svelte
<!-- src/webview/inspector/App.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import '@vscode-elements/elements/dist/vscode-button';
  import '@vscode-elements/elements/dist/vscode-collapsible';
  import type { InspectorData } from './types';

  let data: InspectorData | null = $state(null);

  onMount(() => {
    window.addEventListener('message', (event) => {
      if (event.data.type === 'update') {
        data = event.data.data;
      }
    });
  });
</script>

{#if data}
  <main>
    <h1>{data.title}</h1>
    <vscode-collapsible title="Details" open>
      <!-- Content here -->
    </vscode-collapsible>
  </main>
{:else}
  <p>Loading...</p>
{/if}

<style>
  main {
    padding: 16px;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
</style>
```

### Message Protocol

Type-safe messages between extension and webview:

```typescript
// src/webview/shared/message-types.ts

// Extension → Webview
export type ExtensionMessage =
  | { type: "update"; data: InspectorData }
  | { type: "theme-changed"; theme: "light" | "dark" | "high-contrast" };

// Webview → Extension
export type WebviewMessage =
  | { type: "ready" }
  | { type: "action"; action: string; payload?: unknown };
```

### VS Code Elements Integration

`@vscode-elements/elements` provides web components that match VS Code's native UI:

```svelte
<script>
  import '@vscode-elements/elements/dist/vscode-button';
  import '@vscode-elements/elements/dist/vscode-badge';
  import '@vscode-elements/elements/dist/vscode-collapsible';
  import '@vscode-elements/elements/dist/vscode-icon';
</script>

<vscode-collapsible title="Tool Call: read_file" open>
  <vscode-badge slot="decorations">success</vscode-badge>
  <pre>{toolResult}</pre>
</vscode-collapsible>

<vscode-button on:click={handleClick}>
  <vscode-icon name="refresh" slot="start"></vscode-icon>
  Refresh
</vscode-button>
```

These components automatically use VS Code's CSS variables for theming.

## Implementation Phases

### Phase 1: Infrastructure Setup

1. Add `svelte`, `esbuild-svelte`, `@vscode-elements/elements` dependencies
2. Update esbuild config for dual entry points
3. Create `src/webview/` directory structure
4. Create minimal `InspectorPanel` with "Hello World" Svelte app
5. Verify build produces `dist/webview/inspector.js`

### Phase 2: Inspector Migration

1. Port markdown rendering to Svelte component
2. Add JSON viewer with collapsible sections
3. Add tool call cards with result extraction
4. Wire up message passing for content updates
5. Remove old `TextDocumentContentProvider` approach

### Phase 3: Polish

1. Add syntax highlighting for code blocks
2. Add copy-to-clipboard for JSON/code
3. Persist expanded/collapsed state
4. Add keyboard navigation

## Alternatives Considered

### Vite + Svelte

**Pros:** Full HMR, better dev experience  
**Cons:** Two build systems, more complexity

**Decision:** Start with esbuild-svelte. If dev experience is painful, we can add Vite later.

### React

**Pros:** More familiar to many developers  
**Cons:** Larger runtime, more boilerplate, JSX complexity

**Decision:** Svelte's compile-time approach is a better fit for webviews where bundle size matters.

### Plain HTML + CSS

**Pros:** No build step for webview  
**Cons:** Manual DOM manipulation, no reactivity, harder to maintain

**Decision:** The inspector will grow in complexity; Svelte pays for itself quickly.

### @vscode/webview-ui-toolkit

**Status:** Deprecated January 2025 (FAST Foundation dependency deprecated)  
**Replacement:** `@vscode-elements/elements` (community-maintained, Lit-based)

## Risks and Mitigations

| Risk                         | Mitigation                                                |
| ---------------------------- | --------------------------------------------------------- |
| esbuild-svelte plugin issues | Well-maintained, 500+ GitHub stars, used in production    |
| Svelte 5 breaking changes    | Pin version, update deliberately                          |
| CSP restrictions             | Test thoroughly; vscode-elements is designed for webviews |
| Bundle size growth           | Monitor with `esbuild --analyze`; Svelte compiles small   |

## Success Criteria

1. Inspector opens in a single, reusable panel
2. Content updates without spawning new windows
3. Tool calls display with collapsible details
4. Theme changes reflect immediately
5. Build time increase < 2 seconds
6. Webview bundle < 100KB gzipped

## Future Work

- **Settings webview** — Rich configuration UI
- **Conversation viewer** — Full conversation history with search
- **Token visualizer** — Interactive token breakdown
