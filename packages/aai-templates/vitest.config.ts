import { defineConfig } from "vitest/config";
import { sharedConfig } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    restoreMocks: true,
    include: ["templates/*/agent.test.ts"],
    setupFiles: ["../aai-cli/matchers.ts"],
  },
});
