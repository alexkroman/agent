import { defineUnitProject } from "../../vitest.shared.ts";

export default defineUnitProject({
  name: "aai-gates",
  // A directory glob, never a filename list: a gate spec nobody lists never runs.
  include: ["src/*.test.ts"],
  thresholds: { lines: 97, functions: 97, branches: 90, statements: 93 },
});
