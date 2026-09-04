import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    // Project name for `--project aai-guest`; the workspace root discovers this
    // file by glob, so the name must live here (else it defaults to the
    // package.json name).
    name: "aai-guest",
    include: ["**/*.test.ts"],
    // The slow tiers are a NAMING CONVENTION (`*.integration.test.ts`,
    // `*.scenario.test.ts`), and a rename only relocates a file if the unit
    // config declines it. Without these two globs a rename left the file in
    // the unit tier AND in the slow one — which is why the compensating
    // `timeout: 120_000`s in studio-build/studio-test were written instead of
    // the tier being used. The package owns no infixed file yet; the excludes
    // are what make writing one possible.
    exclude: [
      "node_modules",
      "dist",
      // Guest session SCRATCH. `workspacesRoot()` materializes a workspace here,
      // and the studio's coding agent writes `*.test.ts` into it — so a leftover
      // workspace (from a dev-server run, or a suite that died before its
      // cleanup) is COLLECTED by the glob above and fails this package's suite
      // with somebody else's assertion. It happened: a stray
      // `.workspaces/<pid>/build-4-<token>/sample.test.ts` — a fixture whose whole
      // job is to fail — turned `pnpm check` red with `expected 'cart' to be
      // 'basket'`, naming a file no commit contains. The directory is gitignored,
      // which is exactly why nothing else notices it.
      "src/.workspaces/**",
      "**/*.integration.test.ts",
      "**/*.scenario.test.ts",
    ],
    coverage: {
      exclude: [...sharedCoverageExclude],
      // Ratchet: floors only move up. Raise to ~2-3 points below actuals
      // whenever a coverage run shows comfortable headroom.
      // main() — the HTTP server + upgrade wiring — is exercised by the
      // smoke path against the built artifact, not by unit tests, which is
      // what keeps these floors below the other packages'.
      // Actuals (2026-08): lines 85.79, functions 84.49, branches 75.58, statements 83.88.
      // Actuals (2026-09, with studio-agent/http/session/tool-descriptions
      // specs): lines 85.65, functions 84.38, branches 77.88, statements 84.12.
      // Only `branches` moved: the two readings of it disagree (75.58 vs
      // 77.88), so the floor is set under the LOWER one — the point of a
      // ratchet is that it never has to come back down.
      thresholds: { lines: 83, functions: 82, branches: 74, statements: 81 },
    },
  },
});
