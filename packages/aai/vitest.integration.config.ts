import { defineConfig } from "vitest/config";
import { sharedConfig } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    include: ["host/pentest.test.ts", "host/run-code-isolate.test.ts", "host/integration.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
