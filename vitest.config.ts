import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "./vitest.shared.ts";

// Auto-builds the aai-guest harness bundle createSandbox resolves eagerly.
const ensureGuestHarness = fileURLToPath(
  new URL("./scripts/ensure-guest-harness.mjs", import.meta.url),
);

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
      // Actuals (2026-07): lines ~91%, branches ~80%, functions ~87%, statements ~89%.
      thresholds: {
        lines: 88,
        functions: 84,
        branches: 77,
        statements: 86,
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
            "e2e*.test.ts",
            "node_modules",
            "dist",
          ],
        },
      },
      {
        ...sharedConfig,
        test: {
          name: "aai-guest",
          root: "packages/aai-guest",
          include: ["**/*.test.ts"],
          exclude: ["node_modules", "dist"],
        },
      },
      {
        ...sharedConfig,
        test: {
          name: "aai-server",
          root: "packages/aai-server",
          pool: "forks",
          globalSetup: [ensureGuestHarness],
          include: ["**/*.test.ts"],
          exclude: [
            // LLM-in-the-loop evals: pnpm --filter aai-server test:evals
            // (studio tests live in the aai-studio-server project)
            "sandbox-integration.test.ts",
            "sandbox-lifecycle.test.ts",
            "ws-integration.test.ts",
            "node_modules",
            "dist",
          ],
        },
      },
      {
        ...sharedConfig,
        test: {
          name: "aai-studio-server",
          root: "packages/aai-studio-server",
          pool: "forks",
          include: ["**/*.test.ts"],
          exclude: [
            // LLM-in-the-loop evals: pnpm --filter aai-studio-server test:evals
            "studio-eval.test.ts",
            "node_modules",
            "dist",
          ],
        },
      },
      {
        ...sharedConfig,
        test: {
          name: "aai-studio-client",
          root: "packages/aai-studio-client",
          // Node by default (react-dom/server); interaction tests opt into
          // jsdom via a per-file `@vitest-environment` pragma.
          include: ["**/*.test.{ts,tsx}"],
          exclude: ["node_modules", "dist"],
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
