import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

// Template agents import prompt files with Vite's native `?raw` suffix
// (`import systemPrompt from "./system-prompt.md?raw"`), which vitest
// resolves out of the box — no custom raw-text plugin needed.
export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    // Project name for `--project aai-templates`; the workspace root discovers this
    // file by glob, so the name must live here (else it defaults to the
    // package.json name).
    name: "aai-templates",
    // The template glob is deliberately generic (any `*.test.ts` under a
    // template directory), so a new template's test file is picked up on
    // creation rather than needing this list extended per filename.
    include: [
      "templates.test.ts",
      "template-api-coverage.test.ts",
      "claude-md-limit.test.ts",
      "escape-hatch-scope.test.ts",
      "file-length-gate.test.ts",
      "konsistent-config.test.ts",
      "test-assertion-gate.test.ts",
      "templates/*/*.test.ts",
    ],
    coverage: {
      exclude: [...sharedCoverageExclude, "scaffold/**"],
      // This package had NO floors at all — the only one in the repo — while
      // running `test:coverage` in the CI matrix, so its numbers were measured
      // and then discarded. Seeded ~2-3 points below the first measurement
      // (2026-08: stmts 67.0, branch 53.2, funcs 59.3, lines 69.8); floors
      // only move up from here. They are lower than every other package's on
      // purpose: templates are example agents whose value is being READ, and
      // each one's tests cover its own tools rather than every branch.
      thresholds: { lines: 78, functions: 73, branches: 64, statements: 75 },
    },
  },
});
