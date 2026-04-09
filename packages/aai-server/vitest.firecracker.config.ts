import { defineConfig } from "vitest/config";
import { sharedConfig } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    include: ["firecracker-integration.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
