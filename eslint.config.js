import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

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
      // Allow non-null assertions in specific cases (VS Code APIs often require them)
      "@typescript-eslint/no-non-null-assertion": "warn",
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
    ],
  },
);
