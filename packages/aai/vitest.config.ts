import { defineUnitProject } from "../../vitest.shared.ts";

export default defineUnitProject({
  name: "aai",
  setupFiles: ["./src/host/_test-matchers.ts"],
  // `contracts/` is re-export lists and tsc-only fixtures, never executed.
  coverageExclude: ["src/contracts/**"],
  thresholds: { lines: 92, functions: 88, branches: 83, statements: 90 },
});
