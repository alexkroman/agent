/**
 * Shared Vitest configuration used by the root workspace config
 * and package-specific configs (slow tests, integration tests).
 */
export const sharedConfig = {
  resolve: { conditions: ["@dev/source"] },
  ssr: { resolve: { conditions: ["@dev/source"] } },
  test: {
    reporters: process.env.CI ? ["dot", "github-actions"] : ["default"],
  },
};
