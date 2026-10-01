import { defineUnitProject } from "../../vitest.shared.ts";

export default defineUnitProject({
  name: "aai-guest",
  // v8 measures whatever was LOADED, and `@dev/source` loads the siblings' src/;
  // `include: ["src/**"]` cannot exclude them because their paths match too.
  coverageExclude: ["**/aai-guest-core/**", "**/aai-guest-studio/**"],
  // `main()` (the HTTP server and upgrade wiring) is covered by the smoke path
  // against the built artifact, not by unit tests.
  thresholds: { lines: 67, functions: 66, branches: 74, statements: 68 },
});
