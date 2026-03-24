import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "aai",
          root: "packages/aai",
          globals: true,
          include: ["**/*_test.ts"],
        },
      },
      {
        test: {
          name: "aai-ui",
          root: "packages/aai-ui",
          globals: true,
          include: ["**/*_test.{ts,tsx}"],
          setupFiles: ["./_jsdom_setup.ts"],
        },
      },
      {
        test: {
          name: "aai-cli",
          root: "packages/aai-cli",
          globals: true,
          include: ["**/*_test.{ts,tsx}"],
          exclude: ["pack_build_test.ts", "node_modules", "dist"],
        },
      },
    ],
  },
});
