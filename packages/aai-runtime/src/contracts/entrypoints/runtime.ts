// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `runtime`.
 *
 * Building the thing that runs an agent definition, and starting one
 * session on it. The layer `createAgentServer` is a server around.
 *
 * Re-exported from `@alexkroman1/aai-runtime`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  type AgentRuntime,
  createRuntime,
  decliningRuntime,
  type ExecuteTool,
  type ExecuteToolOptions,
  type RunCodeExecutor,
  type Runtime,
  type RuntimeOptions,
  type SessionRuntime,
  type SessionStartOptions,
  type SkipGreeting,
} from "../../runtime-barrel.ts";
