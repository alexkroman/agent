// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 2.
 *
 * Epoch 3 reshaped the agent declaration in two ways at once, and both are
 * widenings this file exists to hold to.
 *
 * **`AgentDef` grew, partly by extension.** It gained `description` and, by
 * extending three new field-group interfaces, `maxOutputTokens`, `maxRetries`,
 * `resetToolChoice`, `usageLimits`, `inputGuardrails` and `outputGuardrails`.
 * Two fields an epoch-2 author already wrote — `temperature`, and the
 * `events` / `syncState` pair — moved out of `AgentDef`'s own body and onto
 * `AgentModelTuning` and `AgentObservation` in the same change. A moved field
 * is only harmless if the object literal an author writes cannot tell, which
 * is exactly what `desk` below asserts: all three are still written FLAT, in
 * one `agent({ … })` literal, beside `name` and `greeting`.
 *
 * **`systemPrompt` widened from `string` to `string | AgentInstructions`**, so
 * an agent may now compute its instructions per request. The arm that keeps
 * this file compiling is the plain `string` one — every agent below passes
 * text, which is what an epoch-2 author had and the only thing they could
 * pass. Note what this file deliberately does NOT do: it never reads
 * `def.systemPrompt` back out into a `string`-typed binding, because an
 * authoring example is code somebody WRITES an agent with, and the reading
 * half belongs to a host.
 *
 * That is the whole promise — new optional fields, a regrouping the literal
 * cannot see, and one union arm added. If a later epoch drops the string arm,
 * makes any of the new fields required, or moves a field somewhere an inline
 * literal cannot reach, this file reddens, which is the signal to DROP the
 * epoch rather than to edit the example.
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
  sessionSlot,
  workflow,
  workflowApp,
} from "../../../index.ts";

const queueSlot = sessionSlot("queue", () => ({ waiting: 0, agentNotes: "" }), {
  view: (queue) => ({ waiting: queue.waiting }),
});

/** An epoch-2 `events` map: typed handlers, then `"*"`, and observe-only. */
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
 * The declaration an epoch-2 author wrote, and the shape the transition has to
 * keep accepting: one flat literal in which `temperature`, `events` and
 * `syncState` sit beside `name` — even though all three now arrive through an
 * extended interface rather than off `AgentDef`'s own body.
 */
export const desk = agent({
  name: "Front desk",
  systemPrompt: "Answer in one or two sentences. Never guess an order number.",
  greeting: "Front desk, how can I help?",
  voice: "michael",
  llm: "claude-sonnet-4-6",
  // AgentModelTuning, written flat.
  temperature: 0.4,
  // AgentObservation, written flat.
  events,
  syncState: queueSlot.projected,
  // PipelineVoiceTuning, which was already an extended interface at epoch 2 —
  // the seam the three new groups were cut on.
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
  agent,
  assemblyAIPipeline,
  mcpToolName,
  workflowApp,
] as const;
