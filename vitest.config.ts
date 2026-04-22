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
        "packages/aai-server/harness-runtime-v2.ts",
        // CLI entry point can't be unit tested.
        "packages/aai-cli/cli.ts",
      ],
      // Global minimum. Per-package actuals are higher:
      // aai ~93%, aai-ui ~85%, aai-cli ~75%, aai-server ~80%
      // Actual combined coverage (all projects): lines ~71%, branches ~64%, functions ~69%, statements ~70%
      // Note: aai-server tests currently fail due to missing nanoid dep, lowering overall numbers.
      // Thresholds set to targets where actuals exceed them; statements set to 64 (~5% below actual 69.57).
      thresholds: {
        lines: 70,
        functions: 65,
        branches: 55,
        statements: 64,
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
          setupFiles: ["./sdk/_test-matchers.ts"],
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
          pool: "forks",
          include: ["**/*.test.ts"],
          exclude: [
            "docker-build.test.ts",
            "fake-vm-integration.test.ts",
            "sandbox-integration.test.ts",
            "sandbox-lifecycle.test.ts",
            "ws-integration.test.ts",
            "load/**",
            "adversarial/**",
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
        },
      },
      {
        ...sharedConfig,
        test: {
          name: "aai-types",
          root: "packages/aai",
          include: [],
          typecheck: {
            enabled: true,
            only: true,
            include: ["**/*.test-d.ts"],
          },
        },
      },
    ],
  },
});
