import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    // Project name for `--project aai-studio-server`; the workspace root discovers this
    // file by glob, so the name must live here (else it defaults to the
    // package.json name).
    name: "aai-studio-server",
    restoreMocks: true,
    pool: "forks",
    include: ["**/*.test.ts"],
    // Same contended-check-run headroom rationale as aai-server.
    testTimeout: 20_000,
    exclude: [
      // LLM-in-the-loop evals: pnpm --filter aai-studio-server test:evals
      "studio-eval.test.ts",
      "node_modules",
      "dist",
    ],
    coverage: {
      exclude: [...sharedCoverageExclude, "index.ts", "modal_deploy.py"],
      // Ratchet seed for a new package: set just below the first measured
      // actuals; floors only move up from here.
      thresholds: { lines: 92, functions: 90, branches: 78, statements: 88 },
    },
  },
});
