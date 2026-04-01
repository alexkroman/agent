import { defineConfig } from "vitest/config";
import { sharedConfig } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    include: [
      "sandbox-integration.test.ts",
      "sandbox-conformance.test.ts",
      "ws-integration.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
