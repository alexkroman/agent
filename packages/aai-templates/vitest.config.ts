import { aaiAgentPlugin } from "@alexkroman1/aai/testing/vite";
import { defineUnitProject } from "../../vitest.shared.ts";

export default defineUnitProject({
  name: "aai-templates",
  // Serves `virtual:aai/agent` to each template's specs. Prompt files load
  // through Vite's native `?raw` suffix.
  plugins: [aaiAgentPlugin()],
  // Globs, never a filename list: this package's gate specs plus every
  // template's own tests, picked up on creation.
  include: ["src/*.test.ts", "templates/*/*.test.ts"],
  coverageExclude: ["scaffold/**"],
  // Lower than other packages on purpose: templates are read as examples, and
  // each one's tests cover its own tools rather than every branch.
  thresholds: { lines: 89, functions: 89, branches: 76, statements: 87 },
});
