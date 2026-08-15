// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `agent`.
 *
 * Declaring an agent: the `agent()` and `workflowApp()` helpers, the parameter
 * unions that make a mode mistake a compile error, and the shape a declaration
 * resolves to.
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
  type DefaultedAgentField,
  type FrontDoorField,
  type InlineToolsField,
  type InlineToolsMisuse,
  type PipelineAgentParams,
  type PipelineOnlyField,
  type PipelineOnlyMisuse,
  type PipelineVoiceTuning,
  type ProviderField,
  type S2sAgentParams,
  type SharedAgentParams,
  type StaticAgentParams,
  type StaticFrontDoorMisuse,
  type TextAgentParams,
  type ToolChoice,
  type WorkflowAppMisuse,
  type WorkflowAppOnlyField,
  workflowApp,
} from "../../index.ts";
