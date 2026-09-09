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
      // The EVAL tier, by the same naming convention — `studio/agent.eval.test.ts`
      // drives the coding agent against a live model over a real workspace, and
      // `test:eval` is what selects it. Without this glob it would also run here
      // under a 5s budget with no credential gate.
      "**/*.eval.test.ts",
    ],
    coverage: {
      // A workspace dependency resolves to its `src/` through `@dev/source`,
      // and v8 measures whatever was LOADED — so without these this package
      // reports on its dependencies' modules, which its own tests barely
      // exercise. `aai-guest` read 27% lines against a floor of 83 that way.
      // `include: ["src/**"]` does NOT do it: the siblings' paths end in
      // `src/` too and match the same glob.
      exclude: [...sharedCoverageExclude, "**/aai-guest-core/**", "**/aai-guest-studio/**"],
      // Ratchet: floors only move up — and these are LOWER than the numbers
      // this package carried before the split, which needs saying. Nothing
      // regressed: the measured SET changed. 84 well-covered modules left for
      // `aai-guest-core` and `aai-guest-studio`, and what remains is the entry
      // plus nine harness modules, whose `main()` — the HTTP server and upgrade
      // wiring — is exercised by the smoke path against the BUILT artifact
      // rather than by unit tests. That was always true and the studio's 60
      // files used to average it away. Re-seeded ~2-3 points under the actuals
      // (2026-09, at the split): statements 71.18, branches 77.31,
      // functions 69.23, lines 70.25.
      thresholds: { lines: 67, functions: 66, branches: 74, statements: 68 },
    },
  },
});
