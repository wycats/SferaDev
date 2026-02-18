import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/test/**"],
    hookTimeout: 60_000, // Token counter initialization can be slow
  },
});
