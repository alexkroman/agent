import { defineConfig } from "vitest/config";
import { sharedConfig } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    include: ["docker-build.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
