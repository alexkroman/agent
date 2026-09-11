// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 3.
 *
 * Epoch 4 added the regex-keyed endpointing table and the two speak-gate
 * windows to `PipelineVoiceTuning`, plus the five types a rule is written
 * with. Every one of them is an OPTIONAL field or a new type name, so an
 * epoch-3 declaration is untouched — which is the whole content of this
 * file's promise, and what it reddens on if a later epoch makes one of them
 * required or narrows a field an epoch-3 author already wrote.
 *
 * The declaration below therefore deliberately mentions NONE of the new
 * fields. It writes the three `PipelineVoiceTuning` knobs epoch 3 already had
 * — `errorPhrase`, `deadAirCoverMs`, `preemptiveGeneration` — flat in the same
 * literal as `name`, because "flat in one literal" is the property the
 * field-group split has to keep and the one a later regrouping could break.
 *
 * ## Two things about its SHAPE, both imposed rather than chosen
 *
 * **It names every one of epoch 3's 36 exports.** The gate requires it
 * (`api-contracts-gate.test.ts`): a fixture that names one signature freezes
 * one signature, while every other name in the epoch compiles because nothing
 * mentions it. So the back half is a roll-call and the front half is the part
 * written to be read.
 *
 * **Its specifiers are RELATIVE.** Importing the package by name would resolve
 * through its own `exports` map to whatever the current build publishes, so
 * the fixture would prove the CURRENT surface compiles rather than epoch 3's.
 *
 * @module
 */

import type {
  AgentDef,
  AgentGuardrail,
  AgentGuardrails,
  AgentInstructions,
  AgentModelTuning,
  AgentObservation,
  AgentParams,
  AgentSessionContext,
  AgentSystemPrompt,
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
  UsageLimits,
} from "../../../index.ts";
import {
  agent,
  assemblyAIPipeline,
  MCP_SERVER_KEY_RE,
  MCP_TOOL_NAME_MAX,
  MCP_TOOL_PREFIX,
  mcpToolName,
  sessionSlot,
  workflow,
  workflowApp,
} from "../../../index.ts";

const queueSlot = sessionSlot("queue", () => ({ waiting: 0, agentNotes: "" }), {
  view: (queue) => ({ waiting: queue.waiting }),
});

/** An epoch-3 `events` map: typed handlers, then `"*"`. */
const events: SessionEventHandlers = {
  "tool.called": (event, ctx) => {
    void `${ctx.sessionId}:${event.toolName}`;
  },
  "*": (event) => {
    void event.meta.id;
  },
};

const mcpServers: McpServers = {
  docs: {
    url: "https://docs.example/mcp",
    tokenEnv: "DOCS_TOKEN",
    pinnedTools: { search: "abc123" },
  } satisfies McpServerConfig,
};

/**
 * The declaration an epoch-3 author wrote: one flat literal carrying a field
 * from each of the four groups `AgentDef` extends, and a `systemPrompt`
 * RESOLVER rather than a string — the arm epoch 3 added, which a later epoch
 * narrowing the union back would redden here.
 */
export const desk = agent({
  name: "Front desk",
  description: "Answers order questions and books returns.",
  systemPrompt: (ctx: AgentSessionContext) =>
    `Answer in one or two sentences. Session ${ctx.sessionId}.`,
  greeting: "Front desk, how can I help?",
  voice: "michael",
  llm: "claude-sonnet-4-6",
  // AgentModelTuning, written flat.
  temperature: 0.4,
  maxOutputTokens: 400,
  maxRetries: 2,
  resetToolChoice: true,
  usageLimits: { totalTokens: 200_000 },
  // AgentGuardrails, written flat.
  outputGuardrails: [(text: string) => (text.includes("password") ? "Do not say that." : true)],
  // AgentObservation, written flat.
  events,
  syncState: queueSlot.projected,
  // PipelineVoiceTuning, as epoch 3 had it — no endpointing table, no
  // speak-gate windows, which is the point of this file.
  errorPhrase: "Sorry, something went wrong on my end.",
  deadAirCoverMs: 1200,
  preemptiveGeneration: true,
  // And the rest of an ordinary declaration.
  builtinTools: ["web_search", "think"],
  toolChoice: "auto",
  telephony: ["twilio"],
  maxSteps: 8,
  mcpServers,
});

/** The same agent's stages named explicitly, rather than by the defaults. */
export const tuned = agent({
  name: "Tuned desk",
  systemPrompt: "Be brief.",
  ...assemblyAIPipeline({ region: "eu", voice: "michael", minTurnSilenceMs: 300 }),
});

/** A text agent — no audio path, and the same flat literal. */
export const overChat = agent({
  name: "Chat desk",
  text: true,
  systemPrompt: "Answer in writing.",
  temperature: 0.1,
  events,
});

/** A workflow app: an AGENT declaration too, selecting a different front door. */
export const uploads = workflowApp({
  name: "Uploads",
  workflows: {
    ingest: workflow({ description: "Ingest one upload.", run: () => ({ done: true }) }),
  },
});

/** The MCP naming rules a host has to honour when it merges its own servers. */
export function isUsableServerKey(key: string, remote: string): boolean {
  const name = mcpToolName(key, remote);
  return (
    MCP_SERVER_KEY_RE.test(key) &&
    name.startsWith(MCP_TOOL_PREFIX) &&
    name.length <= MCP_TOOL_NAME_MAX
  );
}

// ── The rest of epoch 3's promised surface.
//
//    The example above pins the SHAPES the transition touched; these are the
//    names it promised and did not reach. Named here because a retained epoch
//    is a promise about all of it (`api-contracts-gate.test.ts`).

export type Epoch3Types = {
  agentDef: AgentDef;
  agentGuardrail: AgentGuardrail;
  agentGuardrails: AgentGuardrails;
  agentInstructions: AgentInstructions;
  agentModelTuning: AgentModelTuning;
  agentObservation: AgentObservation;
  agentParams: AgentParams;
  agentSessionContext: AgentSessionContext;
  agentSystemPrompt: AgentSystemPrompt;
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
  usageLimits: UsageLimits;
};

export const epoch3Values = [
  MCP_SERVER_KEY_RE,
  MCP_TOOL_NAME_MAX,
  MCP_TOOL_PREFIX,
  agent,
  assemblyAIPipeline,
  mcpToolName,
  workflowApp,
] as const;
