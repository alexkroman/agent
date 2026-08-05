import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    // Project name for `--project aai-server`; the workspace root discovers this
    // file by glob, so the name must live here (else it defaults to the
    // package.json name).
    name: "aai-server",
    // Process isolation: this suite spawns real subprocesses and mutates
    // process-global state. CLAUDE.md's per-package table has always recorded
    // aai-server as `forks` with that rationale, but the config had lost the
    // setting, so the table and the config disagreed.
    pool: "forks",
    // Auto-builds the aai-guest harness bundle createSandbox resolves eagerly.
    globalSetup: [
      fileURLToPath(new URL("../../scripts/ensure-guest-harness.mjs", import.meta.url)),
    ],
    include: ["**/*.test.ts"],
    // Headroom over vitest's 5s default for `pnpm check` runs, where the
    // whole turbo graph contends for the CPUs and sandbox-adjacent tests
    // (harness spawns, deploy flows) slow several-fold with nothing
    // actually wrong. (Sized when auth still paid argon2id derivations;
    // ownership digests are cheap now, but the contention headroom stays.)
    testTimeout: 20_000,
    // Integration-tier membership is a naming convention, not a hand-kept
    // filename list. The list this replaces had drifted twice over: it named
    // files that no longer existed, and it missed
    // `agent-server.integration.test.ts` (then `agent-server-integration.test.ts`),
    // which boots a REAL harness subprocess and was therefore running in the
    // 5s unit tier with no retry. `test:integration` selects the same glob,
    // so a new integration test needs no edit in either place.
    exclude: ["**/*.integration.test.ts", "node_modules", "dist"],
    coverage: {
      exclude: [...sharedCoverageExclude],
      // Ratchet: floors only move up (functions eased 88→85 once, when the
      // studio surface — its most function-dense code — moved to the
      // aai-studio-server package and took its coverage with it).
      // Raise to ~2-3 points below actuals
      // whenever a coverage run shows comfortable headroom.
      thresholds: { lines: 89, functions: 85, branches: 80, statements: 87 },
    },
  },
});
