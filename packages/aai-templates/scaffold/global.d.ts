/// <reference types="vite/client" />

/**
 * `virtual:aai/agent` — the agent as `aai build` lowers it: `agent.ts` with its
 * `tools/` directory discovered and its `system-prompt.md` applied.
 *
 * Served by `aaiAgentPlugin()` in `vitest.config.ts`, which resolves it against
 * the importing spec's own directory. See `@alexkroman1/aai/testing/vite`.
 */
declare module "virtual:aai/agent" {
  const agentDef: import("@alexkroman1/aai").AgentDef;
  export default agentDef;
}
