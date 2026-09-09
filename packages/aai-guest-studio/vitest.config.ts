import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    // Project name for `--project aai-guest-studio`; the workspace root
    // discovers this file by glob, so the name must live here (else it defaults
    // to the package.json name).
    name: "aai-guest-studio",
    include: ["**/*.test.ts"],
    exclude: [
      "node_modules",
      "dist",
      // Guest session SCRATCH, and it moved with `build.ts`: `workspacesRoot()`
      // is `path.join(import.meta.dirname, ".workspaces", pid)`, so it
      // materializes beside THIS package's source now. The coding agent writes
      // `*.test.ts` into a workspace, so a leftover one (a dev-server run, or a
      // suite that died before its cleanup) is COLLECTED by the glob above and
      // fails this package's suite with somebody else's assertion. It happened
      // once already, in `aai-guest`: a stray
      // `.workspaces/<pid>/build-4-<token>/sample.test.ts` — a fixture whose
      // whole job is to fail — turned `pnpm check` red with `expected 'cart' to
      // be 'basket'`, naming a file no commit contains. The directory is
      // gitignored, which is exactly why nothing else notices it.
      "src/.workspaces/**",
      "**/*.integration.test.ts",
      "**/*.scenario.test.ts",
      // The EVAL tier, by the naming convention — `agent.eval.test.ts` drives
      // the coding agent against a live model over a real workspace, and
      // `test:eval` is what selects it. Without this glob it would also run
      // here under a 5s budget with no credential gate.
      "**/*.eval.test.ts",
    ],
    coverage: {
      // Measure THIS package's source only. Coverage attributes a file to
      // whoever LOADED it, and a workspace dependency resolves to its `src/`
      // through `@dev/source` — so without this, `aai-guest`'s report counted
      // all 60 of `aai-guest-studio`'s modules (its entry imports them, its
      // unit tests exercise almost none) and read 33% lines against a floor of
      // 83. The number that means something per package is its own.
      // A workspace dependency resolves to its `src/` through `@dev/source`,
      // and v8 measures whatever was LOADED — so without these this package
      // reports on its dependencies' modules, which its own tests barely
      // exercise. `aai-guest` read 27% lines against a floor of 83 that way.
      // `include: ["src/**"]` does NOT do it: the siblings' paths end in
      // `src/` too and match the same glob.
      exclude: [...sharedCoverageExclude, "**/aai-guest-core/**"],
      // Ratchet: floors only move up. SEEDED here — this package is new — from
      // the first run after the split, ~2-3 points under the actuals per the
      // rule in AGENTS.md. Actuals (2026-09, at the split): statements 86.49,
      // branches 79.91, functions 88.15, lines 88.00. These are the studio
      // modules' own numbers, which `aai-guest`'s combined report used to
      // carry. Raise when a second run agrees.
      thresholds: { lines: 85, functions: 85, branches: 77, statements: 83 },
    },
  },
});
