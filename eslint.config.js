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
    ],
  },
);
