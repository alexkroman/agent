import { defineUnitProject } from "../../vitest.shared.ts";

export default defineUnitProject({
  name: "aai-evals",
  // Importing `gate.ts` resolves a credential and announces at import time, so
  // the unit tier never loads it (konsistent `eval-gate-is-not-unit-tier`).
  coverageExclude: ["src/gate.ts"],
  thresholds: { lines: 96, functions: 95, branches: 89, statements: 96 },
});
