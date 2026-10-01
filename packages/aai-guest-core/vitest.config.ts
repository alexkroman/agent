import { defineUnitProject } from "../../vitest.shared.ts";

export default defineUnitProject({
  name: "aai-guest-core",
  // Test infrastructure the shared globs miss: it is a real subpath export
  // (`aai-guest-core/test-utils`), so it cannot take the `_` prefix.
  coverageExclude: ["src/test-utils.ts"],
  thresholds: { lines: 84, functions: 71, branches: 73, statements: 83 },
});
