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
        // Sandbox files run inside secure-exec isolates, not vitest.
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
        lines: 83,
        functions: 82,
        branches: 71,
        statements: 82,
      },
    },
    projects: [
      {
        ...sharedConfig,
        test: {
          name: "aai",
          root: "packages/aai",
          globals: true,
          include: ["**/*.test.ts"],
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
          globals: true,
          include: ["**/*.test.ts"],
          exclude: ["pack-build.test.ts", "e2e.test.ts", "node_modules", "dist"],
        },
      },
      {
        ...sharedConfig,
        test: {
          name: "aai-server",
          root: "packages/aai-server",
          globals: true,
          include: ["**/*.test.ts"],
          exclude: ["src/sandbox-integration.test.ts", "node_modules", "dist"],
        },
      },
    ],
  },
});
