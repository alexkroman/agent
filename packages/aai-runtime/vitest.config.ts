import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    // Project name for `--project aai-runtime`; the workspace root discovers
    // this file by glob, so the name must live here (else it defaults to the
    // package.json name).
    name: "aai-runtime",
    // Forks, like aai-server: this package opens sockets, spawns the workflow
    // world and installs process-wide dispatchers, so a leaked handle in one
    // file must not reach the next.
    pool: "forks",
    include: ["**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.integration.test.ts",
      "**/*.scenario.test.ts",
    ],
    coverage: {
      // `contracts/` is neither production source nor test infrastructure: the
      // capability roots are re-export lists and the frozen examples are never
      // executed, so both would count at 0% and drag the package under floors
      // that have nothing to do with what they measure.
      exclude: [
        ...sharedCoverageExclude,
        "src/contracts/**",
        "src/fixtures/**",
        "src/integration/**",
      ],
      // Ratchet: floors only move up. Seeded at ZERO after the split and left
      // there, which made them a gate that could not fail — and the package was
      // also absent from CI's test matrix, so nothing measured them either.
      // Set from the first run that was actually looked at (93.41 / 86.81 /
      // 93.34 / 95.57), ~2-3 points under per the rule in AGENTS.md.
      thresholds: { lines: 93, functions: 91, branches: 84, statements: 91 },
    },
  },
});
