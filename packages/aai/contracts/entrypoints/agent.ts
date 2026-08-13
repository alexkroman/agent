// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `agent`.
 *
 * Declaring an agent: the `agent()` helper, the parameter unions that make a
 * mode mistake a compile error, and the shape a declaration resolves to.
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
  type DefaultSessionState,
  type InferAgentState,
  type PipelineAgentParams,
  type PipelineOnlyField,
  type PipelineOnlyMisuse,
  type PipelineVoiceTuning,
  type ProviderField,
  type S2sAgentParams,
  type SharedAgentParams,
  type TextAgentParams,
  type ToolChoice,
} from "../../index.ts";
