/**
 * Shiki theme that uses CSS variables mapped to VS Code theme colors.
 *
 * This allows syntax highlighting to automatically follow the user's
 * VS Code theme (light, dark, high contrast) without bundling themes.
 */

import { createCssVariablesTheme } from "shiki/core";

/**
 * CSS variables theme for Shiki that maps to VS Code theme variables.
 *
 * The actual CSS variable definitions are in the webview's styles,
 * mapping --shiki-* variables to --vscode-* variables.
 */
export const vscodeTheme = createCssVariablesTheme({
  name: "vscode-variables",
  variablePrefix: "--shiki-",
  variableDefaults: {},
  fontStyle: true,
});

/**
 * CSS that maps Shiki variables to VS Code theme variables.
 *
 * This should be included in the webview's styles. The mappings use
 * VS Code's semantic token colors where available, with fallbacks
 * to ensure reasonable defaults.
 */
export const shikiVscodeCss = `
/* Shiki to VS Code theme variable mappings */
:root {
  /* Base colors */
  --shiki-foreground: var(--vscode-editor-foreground);
  --shiki-background: var(--vscode-editor-background);

  /* Token colors - mapped to VS Code semantic/symbol colors with fallbacks */
  --shiki-token-constant: var(--vscode-symbolIcon-constantForeground, #0070c1);
  --shiki-token-string: var(--vscode-debugTokenExpression-string, #a31515);
  --shiki-token-comment: var(--vscode-editorLineNumber-foreground, #6a9955);
  --shiki-token-keyword: var(--vscode-symbolIcon-keywordForeground, #0000ff);
  --shiki-token-parameter: var(--vscode-symbolIcon-variableForeground, #001080);
  --shiki-token-function: var(--vscode-symbolIcon-functionForeground, #795e26);
  --shiki-token-string-expression: var(--vscode-debugTokenExpression-string, #a31515);
  --shiki-token-punctuation: var(--vscode-editor-foreground);
  --shiki-token-link: var(--vscode-textLink-foreground, #006ab1);
}

/* Dark theme adjustments - VS Code sets these automatically via its variables */
/* High contrast is also handled automatically by VS Code's CSS variables */

/* Code block styling */
.shiki {
  padding: 12px;
  border-radius: 4px;
  overflow-x: auto;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 13px);
  line-height: 1.5;
}

.shiki code {
  font-family: inherit;
  font-size: inherit;
}
`;
