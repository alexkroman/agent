import { defineUnitProject } from "../../vitest.shared.ts";

export default defineUnitProject({
  name: "aai-cli",
  // Points AAI_CONFIG_DIR at a temp dir and scrubs provider keys, so a spec
  // never touches the developer's real ~/.config/aai/config.json.
  setupFiles: ["./src/_test-setup.ts"],
  // The process entry point, exercised by e2e.
  coverageExclude: ["src/cli.ts"],
  thresholds: { lines: 92, functions: 87, branches: 82, statements: 89 },
});
