import { defineUnitProject } from "../../vitest.shared.ts";

export default defineUnitProject({
  name: "aai-cli",
  // Points AAI_CONFIG_DIR at a temp dir and scrubs provider keys, so a spec
  // never touches the developer's real ~/.config/aai/config.json.
  setupFiles: ["./src/_test-setup.ts"],
  // The process entry point, exercised by e2e.
  coverageExclude: ["src/cli.ts"],
  thresholds: { lines: 92, functions: 87, branches: 82, statements: 89 },
  test: {
    // One module graph per worker, as `packages/aai/vitest.config.ts` argues:
    // the setup file above still runs per test file, every spy, env var and
    // global is undone before each test by the shared config, and the two
    // module-level output globals (`_ui.ts`, `_output.ts`) are stubbed per
    // test, not per file. 83 s became 67 s; validated on three shuffle seeds
    // and under coverage before landing.
    isolate: false,
  },
});
