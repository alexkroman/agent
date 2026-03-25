import { defineConfig } from "vitest/config";

const sharedConfig = {
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] } },
} as const;

export default defineConfig({
  ...sharedConfig,
  test: {
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
        // CLI entry point and interactive prompts can't be unit tested.
        "**/cli.ts",
        "**/_prompts.ts",
      ],
      thresholds: {
        lines: 81,
        functions: 82,
        branches: 69,
        statements: 81,
      },
    },
    projects: [
      {
        ...sharedConfig,
        test: {
          name: "aai",
          globals: true,
          include: ["packages/aai/**/*.test.ts"],
        },
      },
      {
        ...sharedConfig,
        test: {
          name: "aai-ui",
          globals: true,
          include: ["packages/aai-ui/**/*.test.{ts,tsx}"],
          setupFiles: ["packages/aai-ui/_jsdom-setup.ts"],
        },
      },
      {
        ...sharedConfig,
        test: {
          name: "aai-cli",
          globals: true,
          include: ["packages/aai-cli/**/*.test.ts"],
          exclude: [
            "packages/aai-cli/pack-build.test.ts",
            "packages/aai-cli/e2e.test.ts",
            "**/node_modules/**",
            "**/dist/**",
          ],
        },
      },
      {
        ...sharedConfig,
        test: {
          name: "aai-server",
          globals: true,
          include: ["packages/aai-server/**/*.test.ts"],
          exclude: [
            "packages/aai-server/src/sandbox-integration.test.ts",
            "**/node_modules/**",
            "**/dist/**",
          ],
        },
      },
    ],
  },
});
