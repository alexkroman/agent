import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    // Project name for `--project aai`; the workspace root discovers this
    // file by glob, so the name must live here (else it defaults to the
    // package.json name).
    name: "aai",
    restoreMocks: true,
    include: ["**/*.test.ts"],
    exclude: [
      "**/pentest.test.ts",
      "**/run-code-sandbox.test.ts",
      "**/integration.test.ts",
      "**/*.integration.test.ts",
      "node_modules",
      "dist",
    ],
    setupFiles: ["./sdk/_test-matchers.ts"],
    coverage: {
      exclude: sharedCoverageExclude,
      // Ratchet: floors only move up. Raise to ~2-3 points below actuals
      // whenever a coverage run shows comfortable headroom.
      thresholds: { lines: 91, functions: 87, branches: 81, statements: 89 },
    },
  },
});
