/**
 * Shared Vitest configuration used by the root workspace config
 * and package-specific configs (slow tests, integration tests).
 */
export const sharedConfig = {
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] } },
};
