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
        "**/dist/**",
        "**/__snapshots__/**",
        // Sandbox harness: runs inside V8 isolates on the platform, not vitest.
        // Covered by integration tests (pnpm test:integration).
        "packages/aai-server/sandbox*.ts",
        "packages/aai-server/harness-runtime.ts",
        // CLI entry point can't be unit tested.
        "packages/aai-cli/cli.ts",
        // OTel session wiring — tested via integration tests, not unit tests.
        "packages/aai/_session-otel.ts",
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
          setupFiles: ["./host/matchers.ts"],
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
            "docker-build.test.ts",
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
          pool: "forks",
          include: ["**/*.test.ts"],
          exclude: [
            "docker-build.test.ts",
            "sandbox-integration.test.ts",
            "ws-integration.test.ts",
            "chaos/**",
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
          include: ["templates/*/agent.test.ts"],
          setupFiles: ["../aai/host/matchers.ts"],
        },
      },
    ],
  },
});
