import { defineConfig } from "vitest/config";
import { sharedConfig } from "./vitest.shared.ts";

/**
 * Root integration test config — kept for backward compatibility.
 * Prefer `turbo run check:integration` which runs per-package configs in parallel.
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
      "packages/aai/host/run-code-sandbox.test.ts",
      "packages/aai/host/integration.test.ts",
      "packages/aai-server/sandbox-integration.test.ts",
      "packages/aai-server/ws-integration.test.ts",
    ],
  },
});
