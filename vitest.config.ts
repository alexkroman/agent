import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "./vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["packages/*/"],
      exclude: [
        ...sharedCoverageExclude,
        // CLI entry point can't be unit tested.
        "packages/aai-cli/cli.ts",
      ],
      // Ratchet: these floors only move UP. When a coverage run shows actuals
      // comfortably above a floor, raise the floor to ~2-3 points below the
      // actual so regressions fail fast but routine refactors don't flap.
      // Actuals (2026-07): lines ~88%, branches ~74%, functions ~86%, statements ~86%.
      thresholds: {
        lines: 85,
        functions: 83,
        branches: 72,
        statements: 83,
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
            "**/*.integration.test.ts",
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
