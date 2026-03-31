import { defineConfig } from "vitest/config";
import { sharedConfig } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    include: ["src/e2e.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
