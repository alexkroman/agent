import { defineUnitProject } from "../../vitest.shared.ts";

export default defineUnitProject({
  name: "aai-ui",
  // Node by default; a file opts into jsdom with `// @vitest-environment jsdom`.
  include: ["**/*.test.{ts,tsx}"],
  setupFiles: ["./src/_jsdom-setup.ts"],
  test: { globals: true },
  // `contracts/` is re-export lists and tsc-only fixtures, never executed.
  coverageExclude: ["src/contracts/**"],
  thresholds: { lines: 94, functions: 90, branches: 89, statements: 94 },
});
