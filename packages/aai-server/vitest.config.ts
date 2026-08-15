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
    // Slow-tier membership is the `.integration.` / `.scenario.` INFIX, not a
    // hand-kept filename list — each script selects the same glob, so a new slow
    // test needs no edit in either place. The list this replaces had gone stale,
    // naming files that no longer existed. Every slow suite this package owns is
    // now a SCENARIO one (a real Postgres, a real WebSocket server, a real
    // bundler), so `check:integration` is deliberately absent here.
    //
    // `agent-server-integration.test.ts` deliberately keeps the un-infixed
    // name and stays in THIS tier, despite booting a real harness subprocess
    // (which is why the 20s timeout above exists) — by the membership rule it is
    // a scenario test. It is the only test exercising subprocess-sandbox.ts /
    // warm-harness.ts / sandbox-vm.ts, so promoting it drops this package's
    // measured line coverage from ~92% to 88.74% and trips the 89% floor below.
    // Moving it means restoring that coverage first, not lowering the floor. It is
    // the same deliberate exception as aai-cli's `integration.test.ts`: the name
    // says integration, the tier is unit, and only the infix decides.
    exclude: ["**/*.integration.test.ts", "**/*.scenario.test.ts", "node_modules", "dist"],
    coverage: {
      exclude: [...sharedCoverageExclude],
      // Ratchet: floors only move up (functions eased 88→85 once, when the
      // studio surface — its most function-dense code — moved to the
      // aai-studio-server package and took its coverage with it).
      // Raise to ~2-3 points below actuals
      // whenever a coverage run shows comfortable headroom.
      thresholds: { lines: 92, functions: 88, branches: 84, statements: 90 },
    },
  },
});
