import { aaiAgentPlugin } from "@alexkroman1/aai/testing/vite";
import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

// Template agents import prompt files with Vite's native `?raw` suffix
// (`import systemPrompt from "./system-prompt.md?raw"`), which vitest
// resolves out of the box — no custom raw-text plugin needed.
export default defineConfig({
  ...sharedConfig,
  // Serves `virtual:aai/agent` to each template's specs — see its module doc.
  plugins: [aaiAgentPlugin()],
  test: {
    ...sharedConfig.test,
    // Project name for `--project aai-templates`; the workspace root discovers this
    // file by glob, so the name must live here (else it defaults to the
    // package.json name).
    name: "aai-templates",
    // BOTH globs, and neither is a filename list.
    //
    // `*.test.ts` covers this directory: the gate specs that hold the repo's
    // repo-level scripts to their contracts (`claude-md-limit`,
    // `escape-hatch-scope`, `file-length-gate`, `konsistent-config`,
    // `test-assertion-gate`, `guard-invariants-gate`) plus this package's own
    // suites. It used to be seven hand-written filenames, which is the same
    // silent-omission trap this package's `tsconfig.json` already had and
    // fixed the same way — three test files were listed nowhere and
    // type-checked by nothing, under a comment describing exactly that. A gate
    // spec nobody adds to a list is a gate spec that never runs, and its whole
    // job is to notice when a gate has gone quiet.
    //
    // `templates/*/*.test.ts` covers each template's own tests, so a new
    // template is picked up on creation.
    include: ["src/*.test.ts", "templates/*/*.test.ts"],
    // The slow-tier infixes, excluded here for the reason every other package
    // excludes them: membership is a NAMING CONVENTION, and the `include` globs
    // above match all three infixes. The gap was latent until it was not —
    // `templates/simple/agent.eval.test.ts` drives a LIVE MODEL, so without the
    // `.eval.` exclusion `pnpm test` would spend tokens on every developer's
    // key under a 5s budget it cannot meet. `check:eval` is what runs it.
    // Declaring no `check:integration`/`check:scenario` script is deliberate and
    // separate: vitest fails a run matching nothing, which beats a green no-op.
    exclude: [
      "**/*.integration.test.ts",
      "**/*.scenario.test.ts",
      "**/*.eval.test.ts",
      "node_modules",
      "dist",
    ],
    coverage: {
      exclude: [...sharedCoverageExclude, "scaffold/**"],
      // This package had NO floors at all — the only one in the repo — while
      // running `test:coverage` in the CI matrix, so its numbers were measured
      // and then discarded. Seeded ~2-3 points below the first measurement
      // (2026-08: stmts 67.0, branch 53.2, funcs 59.3, lines 69.8) and ratcheted
      // since; floors only move up from here. They are lower than every other
      // package's on purpose: templates are example agents whose value is being
      // READ, and each one's tests cover its own tools rather than every branch.
      //
      // Ratcheted 78/73/64/75 -> 84/85/72/82 against measured stmts 84.97-85.04,
      // branch 74.68-75.0, funcs 88.40, lines 86.76 (two runs; v8 moves a little
      // with which files a run touches, so the floor sits under the LOW end).
      // The seed floors had drifted 8-15 points under actual, which is a ratchet
      // nothing can trip.
      thresholds: { lines: 84, functions: 85, branches: 72, statements: 82 },
    },
  },
});
