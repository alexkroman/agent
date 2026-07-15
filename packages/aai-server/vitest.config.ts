import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    restoreMocks: true,
    include: ["**/*.test.ts"],
    exclude: [
      "docker-build.test.ts",
      "orchestrator-integration.test.ts",
      "ws-integration.test.ts",
      "fake-vm-integration.test.ts",
      "gvisor-integration.test.ts",
      "node_modules",
      "dist",
    ],
    coverage: {
      exclude: sharedCoverageExclude,
      // Ratchet: floors only move up. Raise to ~2-3 points below actuals
      // whenever a coverage run shows comfortable headroom.
      thresholds: { lines: 84, functions: 84, branches: 68, statements: 82 },
    },
  },
});
