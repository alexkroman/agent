// Copyright 2026 the AAI authors. MIT license.

/**
 * `virtual:aai/agent` — the agent as `aai build` lowers it: `agent.ts` with its
 * `tools/` directory discovered and its `system-prompt.md` applied.
 *
 * Served by `aaiAgentPlugin()` (and so by `defineAgentTestConfig()`), which
 * resolves it against the importing spec's own directory. See
 * `@alexkroman1/aai/testing/vite`. Loaded by `@alexkroman1/aai/tsconfig`'s
 * `files`, so a project extending it declares nothing.
 */
declare module "virtual:aai/agent" {
  const agentDef: import("@alexkroman1/aai").AgentDef;
  export default agentDef;
}
