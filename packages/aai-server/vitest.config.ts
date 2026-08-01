import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    restoreMocks: true,
    // Auto-builds the aai-guest harness bundle createSandbox resolves eagerly.
    globalSetup: [
      fileURLToPath(new URL("../../scripts/ensure-guest-harness.mjs", import.meta.url)),
    ],
    include: ["**/*.test.ts"],
    // This suite is credential-bound: anything that deploys an agent or
    // authenticates a request runs an argon2id derivation (tens of ms idle,
    // several times that when the CPUs are contended). A test that deploys
    // two agents and
    // then calls authenticated endpoints does that 4-6 times, which lands right
    // on vitest's 5s default when `pnpm check` runs the whole turbo graph in
    // parallel — the tests then fail as timeouts with nothing actually wrong.
    // The headroom keeps that signal honest; it is not covering a slow test.
    testTimeout: 20_000,
    exclude: [
      "orchestrator-integration.test.ts",
      "ws-integration.test.ts",
      "workspace-build-integration.test.ts",
      "node_modules",
      "dist",
    ],
    coverage: {
      exclude: [...sharedCoverageExclude],
      // Ratchet: floors only move up (functions eased 88→85 once, when the
      // studio surface — its most function-dense code — moved to the
      // aai-studio-server package and took its coverage with it).
      // Raise to ~2-3 points below actuals
      // whenever a coverage run shows comfortable headroom.
      thresholds: { lines: 89, functions: 85, branches: 74, statements: 87 },
    },
  },
});
