import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

// ---------------------------------------------------------------------------
// Logging-hygiene lint rules
//
// Rationale: All runtime logging must go through the Logger (output channel)
// or InvestigationLogger (file-based). Direct console.* / fs.write* calls
// bypass level filtering, output-channel routing, and investigation-log
// lifecycle management.
//
// Three scopes need different rules:
//   1. Production code  – console.* and fs.write* are errors
//   2. Logger internals – they ARE the abstraction, so both are allowed
//   3. Test files       – console.* is fine for test output; fs.write* is
//                         fine for harness setup (warn, not error)
// ---------------------------------------------------------------------------

/** Console.* restriction for production source files. */
const noDirectConsole = {
  selector: "CallExpression[callee.object.name='console']",
  message:
    "Direct console.* calls bypass the VS Code output channel and log-level filtering. " +
    "Import `logger` from the logger module and call logger.error/warn/info/debug/trace instead.",
};

/** fs.writeFileSync / fs.appendFileSync restriction for production source files. */
const noSyncFsWrite = {
  selector:
    "CallExpression[callee.object.name='fs'][callee.property.name=/^(writeFileSync|appendFileSync)$/]",
  message:
    "Synchronous fs writes block the extension host and bypass investigation-log lifecycle. " +
    "Use InvestigationLogger (logger/investigation.ts) for file-based logging, " +
    "or logger.* for output-channel logging.",
};

/** fs.promises.writeFile / appendFile restriction for production source files. */
const noAsyncFsWrite = {
  selector:
    "CallExpression[callee.object.property.name='promises'][callee.property.name=/^(writeFile|appendFile)$/]",
  message:
    "Direct fs.promises.* write calls bypass investigation-log lifecycle (rotation, pruning, directory structure). " +
    "Use InvestigationLogger (logger/investigation.ts) for file-based logging, " +
    "or logger.* for output-channel logging.",
};

export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allow numbers and other primitives in template literals
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        {
          allowNumber: true,
          allowBoolean: true,
          allowNullish: true,
          allowRegExp: false,
        },
      ],
      // No non-null assertions — use guards, early returns, or restructure instead
      "@typescript-eslint/no-non-null-assertion": "error",
      // Deprecated APIs are intentionally used during migration
      "@typescript-eslint/no-deprecated": "warn",
      // Allow getters that return literals (common pattern for config defaults)
      "@typescript-eslint/class-literal-property-style": "off",
      // Allow unused variables/args prefixed with underscore
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },

  // ── Production source files: ban console.* and direct fs writes ──────
  {
    files: ["packages/vscode-ai-gateway/src/**/*.ts"],
    ignores: [
      // Logger internals ARE the abstraction — they need console/fs access
      "packages/vscode-ai-gateway/src/logger.ts",
      "packages/vscode-ai-gateway/src/logger/**",
      // Test files get their own, more relaxed rules below
      "packages/vscode-ai-gateway/src/test/**",
      "packages/vscode-ai-gateway/src/**/*.test.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        noDirectConsole,
        noSyncFsWrite,
        noAsyncFsWrite,
      ],
    },
  },

  // ── Test files: ban only unintentional fs writes ─────────────────────
  // console.* is fine in tests (test runner output, debugging).
  // fs.write* is warned (not errored) with a test-specific message.
  {
    files: [
      "packages/vscode-ai-gateway/src/test/**/*.ts",
      "packages/vscode-ai-gateway/src/**/*.test.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          selector:
            "CallExpression[callee.object.name='fs'][callee.property.name=/^(writeFileSync|appendFileSync)$/]",
          message:
            "Prefer os.tmpdir() or a test fixture directory for file writes in tests. " +
            "Sync fs writes in test harness setup are acceptable — add an " +
            "eslint-disable-next-line comment with a brief justification if intentional.",
        },
      ],
    },
  },

  {
    // Disable type-checked rules for JavaScript files
    files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Ignore generated files, build outputs, and reference folders
    ignores: [
      "**/out/**",
      "**/dist/**",
      "**/node_modules/**",
      "**/*.d.ts",
      ".reference/**",
      "packages/openresponses-client/src/generated/**",
      "**/scripts/**",
      "**/.vscode-test/**",
      // RFC design documents (TypeScript interfaces for discussion, not compilable code)
      "docs/**",
    ],
  },
);
