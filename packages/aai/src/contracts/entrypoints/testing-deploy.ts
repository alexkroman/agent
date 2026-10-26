// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `testing-deploy`.
 *
 * Testing an agent AS DEPLOYED rather than as authored: `deployedAgent` (the
 * def a deployment runs, from the project's `tools/` files and
 * `system-prompt.md`), `expectDeployable` (the config the build would ship) and
 * `expectPromptBuiltinsDeclared` (a prompt that names a builtin the agent does
 * not declare).
 *
 * Split off `testing` because these read the BUILD's rules (discovery, the
 * config boundary), which move for reasons a tool's context never does. Part of
 * the `testing` family: `aai-runtime`'s `testing-stubs` door mirrors the whole
 * family.
 *
 * This file is not shipped and nothing imports it — it exists so
 * `pnpm check:api-contracts` can extract a report for this capability alone,
 * hash it, and hold it to a committed epoch. See `scripts/api-contracts.mjs`.
 */

export {
  type DeployedConfig,
  type DeployedStage,
  deployedAgent,
  expectDeployable,
  expectPromptBuiltinsDeclared,
  type ProjectFiles,
} from "../../sdk/testing-barrel.ts";
// `describeAgent(agentDef, (run) => …)`: a `describe` whose first case is
// `expectDeployable`, with the typed runner bound.
export { describeAgent } from "../../sdk/testing-vitest-barrel.ts";
