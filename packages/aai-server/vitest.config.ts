import { fileURLToPath } from "node:url";
import { defineUnitProject } from "../../vitest.shared.ts";

export default defineUnitProject({
  name: "aai-server",
  test: {
    // Spawns real subprocesses and mutates process-global state.
    pool: "forks",
    // Builds the aai-guest harness `createSandbox` resolves eagerly.
    globalSetup: [
      fileURLToPath(new URL("../../scripts/ensure-guest-harness.mjs", import.meta.url)),
    ],
    // Headroom for sandbox-adjacent tests under a contended `pnpm check`.
    testTimeout: 20_000,
  },
  // `agent-server-integration.test.ts` boots a real harness yet stays in the
  // unit tier: it is the only coverage of the subprocess sandbox, and moving it
  // would trip the line floor below.
  thresholds: { lines: 92, functions: 88, branches: 84, statements: 90 },
});
