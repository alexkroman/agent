import { defineUnitProject } from "../../vitest.shared.ts";

export default defineUnitProject({
  name: "aai-ui",
  // Node by default; a file opts into jsdom with `// @vitest-environment jsdom`.
  include: ["**/*.test.{ts,tsx}"],
  setupFiles: ["./src/_jsdom-setup.ts"],
  test: {
    globals: true,
    // One module graph per worker, as `packages/aai/vitest.config.ts` argues.
    // The one thing it cost here is in `_jsdom-setup.ts`: Testing Library's
    // auto-cleanup registers once per module load, so the setup file registers
    // it per test file instead, and clears both web stores before every test,
    // since one jsdom now outlives a file. 72 s became 39 s; validated on six
    // shuffle seeds and under coverage before landing.
    isolate: false,
  },
  // `contracts/` is re-export lists and tsc-only fixtures, never executed.
  coverageExclude: ["src/contracts/**"],
  thresholds: { lines: 94, functions: 90, branches: 89, statements: 94 },
});
