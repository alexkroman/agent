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
        "**/lib/test-utils.ts",
        "**/dist/**",
        "**/__snapshots__/**",
        // Sandbox harness: runs inside V8 isolates on the platform, not vitest.
        // Covered by integration tests (pnpm test:integration).
        "packages/aai-server/src/sandbox*.ts",
        "packages/aai-server/src/lib/harness-runtime.ts",
        "packages/aai-server/src/build-harness.ts",
        // CLI entry point and interactive prompts can't be unit tested.
        "packages/aai-cli/src/cli.ts",
        "packages/aai-cli/src/lib/prompts.ts",
        // OTel session wiring — tested via integration tests, not unit tests.
        "packages/aai/src/_session-otel.ts",
      ],
      // Global minimum. Per-package actuals are higher:
      // aai ~93%, aai-ui ~85%, aai-cli ~75%, aai-server ~80%
      thresholds: {
        lines: 35,
        functions: 50,
        branches: 18,
        statements: 33,
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
            "**/pentest.test.ts",
            "**/run-code-sandbox.test.ts",
            "**/integration.test.ts",
            "node_modules",
            "dist",
          ],
          setupFiles: ["./src/host/matchers.ts"],
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
          setupFiles: ["./src/lib/jsdom-setup.ts"],
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
            "src/e2e.test.ts",
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
          include: ["templates/*/agent.test.ts", "src/typecheck.test.ts"],
          setupFiles: ["../aai/src/host/matchers.ts"],
        },
      },
    ],
  },
});
