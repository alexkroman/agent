import { defineUnitProject } from "../../vitest.shared.ts";

export default defineUnitProject({
  name: "aai-runtime",
  // Opens sockets, spawns the workflow world and installs process-wide
  // dispatchers, so a leaked handle in one file must not reach the next.
  test: { pool: "forks" },
  // `contracts/` is re-export lists and never-executed examples; `integration/`
  // is the integration tier's harness.
  coverageExclude: ["src/contracts/**", "src/fixtures/**", "src/integration/**"],
  thresholds: { lines: 93, functions: 91, branches: 84, statements: 91 },
});
