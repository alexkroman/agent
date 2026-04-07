import { defineConfig } from "vitest/config";
import { sharedConfig } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    include: [
      "sandbox-integration.test.ts",
      "ws-integration.test.ts",
      "process-jail.integration.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    retry: 2,
  },
});
