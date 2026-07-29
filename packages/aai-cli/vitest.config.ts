import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    restoreMocks: true,
    include: ["**/*.test.ts"],
    exclude: ["e2e*.test.ts", "node_modules", "dist"],
    // Isolates the global config dir (API key + approved servers) from the
    // developer's real one — see _test-setup.ts.
    setupFiles: ["./_test-setup.ts"],
    coverage: {
      // cli.ts is the process entry point — exercised by e2e, not unit tests.
      exclude: [...sharedCoverageExclude, "cli.ts", "_test-setup.ts"],
      // Ratchet: floors only move up. Raise to ~2-3 points below actuals
      // whenever a coverage run shows comfortable headroom.
      thresholds: { lines: 86, functions: 84, branches: 74, statements: 85 },
    },
  },
});
