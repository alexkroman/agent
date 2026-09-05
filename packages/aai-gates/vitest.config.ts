import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    // Project name for `--project aai-gates`; the workspace root discovers this
    // file by glob, so the name must live here (else it defaults to the
    // package.json name).
    name: "aai-gates",
    // A directory glob, never a filename list. A gate spec nobody adds to a
    // list is a gate spec that never runs, and its whole job is to notice when
    // a gate has gone quiet.
    include: ["src/*.test.ts"],
    // The slow-tier infixes, excluded for the reason every other package
    // excludes them: membership is a NAMING CONVENTION and the glob above
    // matches all three. Nothing here belongs in a slow tier today — these
    // specs read files and parse them — so no `check:integration` or
    // `check:scenario` script is declared either: vitest fails a run matching
    // nothing, which beats a green no-op.
    exclude: [
      "**/*.integration.test.ts",
      "**/*.scenario.test.ts",
      "**/*.eval.test.ts",
      "node_modules",
      "dist",
    ],
    coverage: {
      exclude: [...sharedCoverageExclude],
      // This package is almost entirely test files; `_gate-support.ts` is the
      // only module coverage can measure, and every spec here imports it, so
      // the numbers are high and stable. Seeded ~2-3 points under the first
      // measurement (2026-09: stmts 96.0, branch 93.33, funcs 100, lines 100)
      // per the repo's ratchet rule; they only move up from here.
      thresholds: { lines: 97, functions: 97, branches: 90, statements: 93 },
    },
  },
});
