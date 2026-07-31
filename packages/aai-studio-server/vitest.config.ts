import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    restoreMocks: true,
    pool: "forks",
    include: ["**/*.test.ts"],
    // Same credential-bound headroom rationale as aai-server: deploys and
    // authenticated requests pay argon2id derivations under a contended
    // check run.
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
      thresholds: { lines: 84, functions: 79, branches: 75, statements: 82 },
    },
  },
});
