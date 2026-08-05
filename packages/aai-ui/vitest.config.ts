import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    // Project name for `--project aai-ui`; the workspace root discovers this
    // file by glob, so the name must live here (else it defaults to the
    // package.json name).
    name: "aai-ui",
    restoreMocks: true,
    globals: true,
    include: ["**/*.test.{ts,tsx}"],
    setupFiles: ["./_jsdom-setup.ts"],
    coverage: {
      exclude: sharedCoverageExclude,
      // Ratchet: floors only move up. Raise to ~2-3 points below actuals
      // whenever a coverage run shows comfortable headroom.
      thresholds: { lines: 94, functions: 90, branches: 89, statements: 94 },
    },
  },
});
