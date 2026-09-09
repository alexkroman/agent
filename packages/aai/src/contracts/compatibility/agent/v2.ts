// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 2.
 *
 * Epoch 3 widened `systemPrompt` from `string` to `string | (() => string)`, so
 * a prompt can be resolved per turn. Every epoch-2 agent wrote the string, and
 * a widened union accepts each of them unchanged — that is the promise this
 * file tests rather than asserts.
 *
 * The shapes below are the ones the transition could plausibly have broken, and
 * they are here because the ways an author reaches this field are not one:
 * `agent()` at the call site, `AgentParams` as an options bag assembled
 * elsewhere, and `AgentDef` as the def a helper takes or returns. A narrowing —
 * or a `SystemPromptOption` that stopped admitting a bare string — reddens all
 * three, which is the signal to DROP this epoch rather than to edit the file.
 *
 * ## Two things about its SHAPE, both imposed rather than chosen
 *
 * **It names every one of epoch 2's 28 exports.** The gate requires it
 * (`api-contracts-gate.test.ts`) and the reason is worth understanding: a
 * fixture that names one signature freezes one signature, while every other
 * name in the epoch compiles because nothing mentions it. So the back half of
 * this file is a roll-call, and the front half is the part written to be read.
 *
 * **Its specifiers are RELATIVE.** The same gate insists, and rightly:
 * importing the package by name would resolve through its own `exports` map to
 * whatever the current build publishes, so the fixture would prove the CURRENT
 * surface compiles rather than that epoch 2's does.
 *
 * @module
 */

import type {
  AgentDef,
  AgentParams,
  AssemblyAIPipelineOptions,
  BuiltinTool,
  McpServerConfig,
  McpServers,
  PipelineAgentParams,
  PipelineVoiceTuning,
  ProviderCredentialOptions,
  ProviderDescriptor,
  S2sAgentParams,
  SessionEventContext,
  SessionEventHandler,
  SessionEventHandlers,
  SessionEventType,
  SharedAgentParams,
  StaticAgentParams,
  TelephonyAccess,
  TelephonyCarrier,
  TextAgentParams,
  ToolChoice,
} from "../../../index.ts";
import {
  agent,
  assemblyAIPipeline,
  MCP_SERVER_KEY_RE,
  MCP_TOOL_NAME_MAX,
  MCP_TOOL_PREFIX,
  mcpToolName,
  workflowApp,
} from "../../../index.ts";

// The prompt as a string, written at the call site.
export const inline = agent({
  name: "Inline",
  systemPrompt: "Be brief.",
  voice: "michael",
});

// The same field arriving in an options bag — the shape that makes a widening
// worth testing, since `AgentParams` is where a narrowing would bite an author
// who never names the field's type.
const bag: AgentParams = { name: "Composed", systemPrompt: "Be brief." };
export const composed = agent(bag);

// A helper over the resolved definition, which is how a project shares prompt
// rules between agents. Its parameter type is `AgentDef["systemPrompt"]` by way
// of the def, so it is the third way the field's type reaches user code.
export function promptOf(def: AgentDef): AgentDef["systemPrompt"] {
  return def.systemPrompt;
}

// ── The rest of epoch 2's promised surface.
//
//    The example above pins the SHAPES the transition touched; these are the
//    names it promised and did not reach. Named here because a retained epoch
//    is a promise about all of it, and a fixture that names one signature
//    freezes one signature (`api-contracts-gate.test.ts`).

export type Epoch2Types = {
  agentDef: AgentDef;
  agentParams: AgentParams;
  assemblyAIPipelineOptions: AssemblyAIPipelineOptions;
  builtinTool: BuiltinTool;
  mcpServerConfig: McpServerConfig;
  mcpServers: McpServers;
  pipelineAgentParams: PipelineAgentParams;
  pipelineVoiceTuning: PipelineVoiceTuning;
  providerCredentialOptions: ProviderCredentialOptions;
  providerDescriptor: ProviderDescriptor<string, Record<string, unknown>>;
  s2sAgentParams: S2sAgentParams;
  sessionEventContext: SessionEventContext;
  sessionEventHandler: SessionEventHandler;
  sessionEventHandlers: SessionEventHandlers;
  sessionEventType: SessionEventType;
  sharedAgentParams: SharedAgentParams;
  staticAgentParams: StaticAgentParams;
  telephonyAccess: TelephonyAccess;
  telephonyCarrier: TelephonyCarrier;
  textAgentParams: TextAgentParams;
  toolChoice: ToolChoice;
};

export const epoch2Values = [
  MCP_SERVER_KEY_RE,
  MCP_TOOL_NAME_MAX,
  MCP_TOOL_PREFIX,
  assemblyAIPipeline,
  mcpToolName,
  workflowApp,
] as const;
