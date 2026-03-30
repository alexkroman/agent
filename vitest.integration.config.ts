import { defineConfig } from "vitest/config";
import { sharedConfig } from "./vitest.shared.ts";

/**
 * Unified integration test config.
 *
 * Runs tests that require real subsystems (V8 isolates, HTTP servers, etc.)
 * and are excluded from the fast unit-test run.
 *
 * Usage: pnpm test:integration
 */
export default defineConfig({
  ...sharedConfig,
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: [
      "packages/aai/host/pentest.test.ts",
      "packages/aai/host/run-code-isolate.test.ts",
      "packages/aai/host/integration.test.ts",
      "packages/aai-server/src/sandbox-integration.test.ts",
      "packages/aai-server/src/ws-integration.test.ts",
    ],
  },
});
