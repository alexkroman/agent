// Copyright 2026 the AAI authors. MIT license.

/**
 * `virtual:aai/agent` — the agent as `aai build` lowers it: `agent.ts` with its
 * `tools/` directory discovered and its `system-prompt.md` applied.
 *
 * Served by `aaiAgentPlugin()` (and so by `defineAgentTestConfig()`), which
 * resolves it against the importing spec's own directory. See
 * `@alexkroman1/aai/testing/vite`. Loaded by `@alexkroman1/aai/tsconfig`'s
 * `files`, so a project extending it declares nothing.
 *
 * ## Why the default export is `AgentDef`, not typed per agent
 *
 * The plugin knows every `tools/*.ts` FILE, so it could emit a `tools` map
 * keyed by name — but a `declare module` is ONE declaration for the whole
 * program, and the module resolves to a different agent per importing
 * directory: a program holding two agents (every template repo, any monorepo)
 * would need two types under one specifier, which TypeScript cannot express.
 * Typing it per agent would mean the plugin WRITING a `.d.ts` into the
 * project per agent directory and the project including it, which is a build
 * artifact in the source tree and a second thing to keep in step.
 *
 * So the def is `AgentDef`, and the typed path is the tool's DEF: a
 * `tools/<name>.ts` default export IS the object the deployed agent registers,
 * so `toolRunner(agentDef).run(addItem, args)` resolves it by identity and
 * answers `InferToolOutput<typeof addItem>`, with no name to type.
 */
declare module "virtual:aai/agent" {
  const agentDef: import("@alexkroman1/aai").AgentDef;
  export default agentDef;
}
