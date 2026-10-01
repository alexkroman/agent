import { defineUnitProject } from "../../vitest.shared.ts";

export default defineUnitProject({
  name: "aai-guest-studio",
  // v8 measures whatever was LOADED, and `@dev/source` loads the sibling's src/;
  // `include: ["src/**"]` cannot exclude it because its paths match too.
  coverageExclude: ["**/aai-guest-core/**"],
  thresholds: { lines: 85, functions: 85, branches: 77, statements: 83 },
});
