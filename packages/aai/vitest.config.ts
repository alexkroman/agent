import { defineConfig } from "vitest/config";
import { sharedConfig } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    restoreMocks: true,
    include: ["**/*.test.ts"],
    exclude: [
      "**/pentest.test.ts",
      "**/run-code-sandbox.test.ts",
      "**/integration.test.ts",
      "node_modules",
      "dist",
    ],
    setupFiles: ["./sdk/_test-matchers.ts"],
  },
});
