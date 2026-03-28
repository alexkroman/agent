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
        // Test infrastructure
        "**/*.test.{ts,tsx}",
        "**/*.test-d.ts",
        "**/_test-utils.ts",
        "**/templates/**",
        "**/dist/**",
        "**/__snapshots__/**",
        // Sandbox harness: runs inside secure-exec V8 isolates, not vitest.
        // Covered by integration tests (pnpm test:integration).
        "packages/aai-server/src/sandbox*.ts",
        "packages/aai-server/src/_harness-runtime.ts",
        "packages/aai-server/src/build-harness.ts",
        // CLI entry point and interactive prompts can't be unit tested.
        "packages/aai-cli/cli.ts",
        "packages/aai-cli/_prompts.ts",
        // OTel session wiring — tested via integration tests, not unit tests.
        "packages/aai/_session-otel.ts",
      ],
      // Global minimum. Per-package actuals are higher:
      // aai ~93%, aai-ui ~85%, aai-cli ~75%, aai-server ~80%
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
          include: ["**/*.test.ts"],
          exclude: [
            "pentest.test.ts",
            "run-code-isolate.test.ts",
            "integration.test.ts",
            "node_modules",
            "dist",
          ],
          setupFiles: ["./matchers.ts"],
        },
      },
      {
        ...sharedConfig,
        test: {
          name: "aai-types",
          root: "packages/aai",
          include: ["**/*.test-d.ts"],
          typecheck: { enabled: true, only: true },
        },
      },
      {
        ...sharedConfig,
        test: {
          name: "aai-ui",
          root: "packages/aai-ui",
          globals: true,
          include: ["**/*.test.{ts,tsx}"],
          setupFiles: ["./_jsdom-setup.ts"],
        },
      },
      {
        ...sharedConfig,
        test: {
          name: "aai-ui-types",
          root: "packages/aai-ui",
          include: ["**/*.test-d.ts"],
          typecheck: { enabled: true, only: true },
        },
      },
      {
        ...sharedConfig,
        test: {
          name: "aai-cli",
          root: "packages/aai-cli",
          include: ["**/*.test.ts"],
          exclude: [
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
          include: ["**/*.test.ts"],
          exclude: [
            "src/sandbox-integration.test.ts",
            "src/sandbox-conformance.test.ts",
            "src/ws-integration.test.ts",
            "node_modules",
            "dist",
          ],
        },
      },
      {
        ...sharedConfig,
        test: {
          name: "templates",
          root: "packages/aai-templates",
          include: ["*/agent.test.ts"],
          setupFiles: ["../aai/matchers.ts"],
        },
      },
    ],
  },
});
