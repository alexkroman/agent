import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    restoreMocks: true,
    include: ["**/*.test.ts"],
    // This suite is credential-bound: anything that deploys an agent or
    // authenticates a request runs PBKDF2 at 600k iterations (~300ms idle,
    // ~750ms when the CPUs are contended). A test that deploys two agents and
    // then calls authenticated endpoints does that 4-6 times, which lands right
    // on vitest's 5s default when `pnpm check` runs the whole turbo graph in
    // parallel — the tests then fail as timeouts with nothing actually wrong.
    // The headroom keeps that signal honest; it is not covering a slow test.
    testTimeout: 20_000,
    exclude: [
      "docker-build.test.ts",
      "orchestrator-integration.test.ts",
      "ws-integration.test.ts",
      "fake-vm-integration*.test.ts",
      "gvisor-integration*.test.ts",
      "node_modules",
      "dist",
    ],
    coverage: {
      exclude: [...sharedCoverageExclude],
      // Ratchet: floors only move up. Raise to ~2-3 points below actuals
      // whenever a coverage run shows comfortable headroom.
      thresholds: { lines: 89, functions: 88, branches: 74, statements: 87 },
    },
  },
});
