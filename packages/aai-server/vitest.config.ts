import { defineConfig } from "vitest/config";
import { sharedConfig } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    restoreMocks: true,
    include: ["**/*.test.ts"],
    exclude: [
      "src/sandbox-integration.test.ts",
      "src/sandbox-conformance.test.ts",
      "src/ws-integration.test.ts",
      "node_modules",
      "dist",
    ],
  },
});
