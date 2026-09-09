import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    // Project name for `--project aai-guest-core`; the workspace root discovers
    // this file by glob, so the name must live here (else it defaults to the
    // package.json name).
    name: "aai-guest-core",
    include: ["**/*.test.ts"],
    exclude: ["node_modules", "dist", "**/*.integration.test.ts", "**/*.scenario.test.ts"],
    coverage: {
      // Measure THIS package's source only. Coverage attributes a file to
      // whoever LOADED it, and a workspace dependency resolves to its `src/`
      // through `@dev/source` — so without this, `aai-guest`'s report counted
      // all 60 of `aai-guest-studio`'s modules (its entry imports them, its
      // unit tests exercise almost none) and read 33% lines against a floor of
      // 83. The number that means something per package is its own.
      // `test-utils.ts` is test infrastructure that happens not to be
      // `_`-prefixed — it cannot be, being a real subpath export (see its own
      // doc) — so the shared globs do NOT catch it and it is named here.
      // Without this the package measures its own harness as production source,
      // which is the inflated-floor failure `sharedCoverageExclude` exists for.
      exclude: [...sharedCoverageExclude, "src/test-utils.ts"],
      // Ratchet: floors only move up. SEEDED here — this package is new — from
      // the first run after the split, ~2-3 points under the actuals per the
      // rule in AGENTS.md. Actuals (2026-09, at the split): statements 86.52,
      // branches 75.86, functions 74.28, lines 87.40. Raise when a second run
      // agrees; the disagreement between two readings is exactly what one
      // reading cannot see.
      thresholds: { lines: 84, functions: 71, branches: 73, statements: 83 },
    },
  },
});
