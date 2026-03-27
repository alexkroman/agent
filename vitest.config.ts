import { defineConfig } from "vitest/config";
import { sharedConfig } from "./vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["packages/*/"],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/_test-utils.ts",
        "**/templates/**",
        "**/dist/**",
        "**/__snapshots__/**",
        // Sandbox core + harness files run inside secure-exec isolates, not vitest.
        // Covered by integration test (pnpm test:integration).
        "**/sandbox.ts",
        "**/sandbox-harness.ts",
        "**/sandbox-network.ts",
        "**/sandbox-sidecar.ts",
        "**/sandbox-integration.test.ts",
        "**/build-harness.ts",
        // Harness runtime is bundled by Vite into CJS for the isolate.
        "**/_harness-runtime.ts",
        // OTel session wiring — tested via integration tests, not unit tests.
        "**/_session-otel.ts",
        // CLI entry point and interactive prompts can't be unit tested.
        "**/cli.ts",
        "**/_prompts.ts",
      ],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 60,
        statements: 60,
      },
    },
    projects: [
      {
        ...sharedConfig,
        test: {
          name: "aai",
          root: "packages/aai",
          restoreMocks: true,
          include: ["**/*.test.ts"],
          setupFiles: ["./matchers.ts"],
        },
      },
      {
        ...sharedConfig,
        test: {
          name: "aai-ui",
          root: "packages/aai-ui",
          globals: true,
          restoreMocks: true,
          include: ["**/*.test.{ts,tsx}"],
          setupFiles: ["./_jsdom-setup.ts"],
        },
      },
      {
        ...sharedConfig,
        test: {
          name: "aai-cli",
          root: "packages/aai-cli",
          restoreMocks: true,
          include: ["**/*.test.ts"],
          exclude: [
            "pack-build.test.ts",
            "e2e.test.ts",
            "node_modules",
            "dist",
          ],
        },
      },
      {
        ...sharedConfig,
        test: {
          name: "aai-server",
          root: "packages/aai-server",
          restoreMocks: true,
          include: ["**/*.test.ts"],
          exclude: [
            "src/sandbox-integration.test.ts",
            "node_modules",
            "dist",
          ],
        },
      },
      {
        ...sharedConfig,
        test: {
          name: "aai-slack",
          root: "packages/aai-slack",
          restoreMocks: true,
          include: ["**/*.test.ts"],
        },
      },
    ],
  },
});
