import { defineUnitProject } from "../../vitest.shared.ts";

export default defineUnitProject({
  name: "aai-studio-server",
  // Headroom under a contended `pnpm check`, as in aai-server.
  test: { pool: "forks", testTimeout: 20_000 },
  // `studio-eval-target.ts` needs a live key and studio for all but `readTurn`,
  // which its spec covers with canned SSE.
  coverageExclude: ["src/index.ts", "src/studio-eval-target.ts", "modal_deploy.py"],
  thresholds: { lines: 96, functions: 93, branches: 90, statements: 94 },
});
