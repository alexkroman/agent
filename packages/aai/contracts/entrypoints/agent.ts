// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `agent`.
 *
 * Declaring an agent: the `agent()` and `workflowApp()` helpers, the parameter
 * unions that make a mode mistake a compile error, and the shape a declaration
 * resolves to.
 *
 * The `events` handler types are here for the same reason `AgentDef` is: they are
 * the SHAPE of an `agent({ events })` declaration, so a change to them is a change
 * to what declaring an agent looks like. `SessionEvent` itself is deliberately not
 * — it is the wire union, contracted nowhere here because `/protocol` is a
 * non-authoring subpath.
 *
 * `workflowApp()` belongs here rather than in `workflow`: it declares an AGENT
 * (returning `AgentDef`, like `agent()`), and what it selects is a front door.
 * The `workflow` capability is the runs themselves — `workflow()`, and what a
 * caller of `ctx.workflows` reads.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type AgentDef,
  type AgentParams,
  type AssemblyAIPipelineOptions,
  agent,
  assemblyAIPipeline,
  type BuiltinTool,
  type PipelineAgentParams,
  type PipelineVoiceTuning,
  type S2sAgentParams,
  type SessionEventContext,
  type SessionEventHandler,
  type SessionEventHandlers,
  type SharedAgentParams,
  type StaticAgentParams,
  type TextAgentParams,
  type ToolChoice,
  workflowApp,
} from "../../index.ts";
