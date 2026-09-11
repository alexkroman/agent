// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 3.
 *
 * ## Epoch 4 carries FOUR changes, and this capability's surface moved for all
 *
 * Epoch 4 is one epoch covering four features that shipped in one release, so
 * the reason the hash moved is worth naming per feature rather than in the
 * aggregate. All four are additive to `AgentDef`, and every field is optional:
 *
 * - **Voice presets** — a FIFTH field-group interface, `AgentVoicePresets`,
 *   whose one field `voicePresets` names the opt-in prompt presets, plus
 *   `VoicePresetName` and the `VOICE_PRESETS` text itself.
 * - **Turn-taking rules and gates** — `endpointingRules` and the five
 *   endpointing-rule types, plus `startSpeakingFloorMs`,
 *   `interruptionBackoffMs`, `acknowledgementPhrases` and
 *   `interruptionPhrases`, all through `PipelineVoiceTuning`.
 * - **The low-confidence band** — `lowConfidence` and the three
 *   `LowConfidence*` types, also through `PipelineVoiceTuning`. (The STT half
 *   of that feature is not here: `keyterms` is a field of the `assemblyAIStt`
 *   descriptor and moved `aai:stt` instead.)
 * - **Tool-call speech** — `ToolDef.messages`. `AgentDef.tools` names
 *   `ToolDef`, so this capability's report moved with it even though nothing
 *   an `agent()` literal contains changed shape.
 *
 * That last one is the one to read carefully, because it is a different KIND of
 * move from the other three: the first three widened what this capability's own
 * declaration accepts, where the fourth is ROLLUP COLLATERAL — a type this
 * report reaches through `AgentDef.tools` changed, and the hash followed. Both
 * kinds are `--retain`, and the promise is the same either way, but a reader
 * asking which feature widened `agent()` should not have to guess.
 *
 * This file is what says the whole set is additive. Every field is optional,
 * nothing an epoch-3 author wrote moved to reach any of them, and an agent that
 * names none of it is emitted the byte-identical system prompt it was at epoch 3
 * (`system-prompt.test.ts` pins exactly that). The one shape worth holding to is
 * the negative: `agent({ … })` below is a flat literal naming none of the four
 * features, so if a later epoch ever made a preset the default — or made any of
 * these fields required, or moved one somewhere a literal cannot reach — this
 * file reddens, which is the signal to DROP the epoch rather than to edit the
 * example.
 *
 * The other half of epoch 3's own promise is unchanged and still tested here:
 * the four field groups it introduced (`AgentModelTuning`, `AgentGuardrails`,
 * `AgentObservation` and the voice tuning that predates them) are written FLAT
 * in one object literal, and `systemPrompt` takes either a string or an
 * `AgentInstructions` resolver. Both arms appear below, because an epoch-3
 * author had both.
 *
 * **And the field groups are exercised BOTH ways**, which is the one thing the
 * union of the four branches' examples added over the widest single one. Flat
 * in a literal is what most authors write and is what the `desk` agent below
 * does; built as standalone TYPED VALUES and spread in is the shape that proves
 * those interfaces are independently constructible, which is the whole reason
 * they are separate interfaces rather than inline field lists. `spreadDesk` at
 * the end of this file is that second arm. An epoch-3 author had both, so a
 * later epoch that made either unwritable has to drop the epoch.
 *
 * ## Two things about its SHAPE, both imposed rather than chosen
 *
 * **It names every one of epoch 3's 36 exports.** The gate requires it
 * (`api-contracts-gate.test.ts`) and the reason is worth understanding: a
 * fixture that names one signature freezes one signature, while every other
 * name in the epoch compiles because nothing mentions it. So the back half of
 * this file is a roll-call, and the front half is the part written to be read.
 *
 * **Its specifiers are RELATIVE.** The same gate insists, and rightly:
 * importing the package by name would resolve through its own `exports` map to
 * whatever the current build publishes, so the fixture would prove the CURRENT
 * surface compiles rather than that epoch 3's does.
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

const queueSlot = sessionSlot("queue", () => ({ waiting: 0, verified: false }), {
  view: (queue) => ({ waiting: queue.waiting }),
});

/** An epoch-3 `events` map: typed handlers, then `"*"`, and observe-only. */
const events: SessionEventHandlers = {
  "tool.called": (event, ctx) => {
    void `${ctx.sessionId}:${event.toolName}`;
  },
  "*": (event) => {
    void event.meta.id;
  },
};

/** An epoch-3 guardrail: a verdict, and nothing that speaks. */
const noAccountNumbers: AgentGuardrail = (text) =>
  /\b\d{9,}\b/.test(text) ? "Do not read an account number aloud." : true;

const mcpServers: McpServers = {
  docs: {
    url: "https://docs.example/mcp",
    tokenEnv: "DOCS_TOKEN",
    pinnedTools: { search: "abc123" },
  } satisfies McpServerConfig,
};

/**
 * The declaration an epoch-3 author wrote: one flat literal in which the model
 * knobs, the guardrails, the observation pair and the voice tuning all sit
 * beside `name`, and in which `voicePresets` does not appear at all.
 */
export const desk = agent({
  name: "Front desk",
  systemPrompt: "Answer in one or two sentences. Never guess an order number.",
  greeting: "Front desk, how can I help?",
  voice: "michael",
  llm: "claude-sonnet-4-6",
  // AgentModelTuning, written flat.
  temperature: 0.4,
  maxOutputTokens: 400,
  maxRetries: 1,
  resetToolChoice: true,
  usageLimits: { totalTokens: 200_000 } satisfies UsageLimits,
  // AgentGuardrails, written flat.
  inputGuardrails: [noAccountNumbers],
  outputGuardrails: [noAccountNumbers],
  // AgentObservation, written flat.
  events,
  syncState: queueSlot.projected,
  // PipelineVoiceTuning.
  errorPhrase: "Sorry, something went wrong on my end.",
  deadAirCoverMs: 1200,
  preemptiveGeneration: true,
  // And the rest of an ordinary declaration.
  description: "Answers the front desk line.",
  builtinTools: ["web_search", "think"],
  toolChoice: "auto",
  telephony: ["twilio"],
  maxSteps: 8,
  mcpServers,
});

/**
 * The other arm of `systemPrompt`, which epoch 3 is where it arrived: a
 * resolver, reading the session it was handed.
 */
const perRequest: AgentInstructions = (ctx: AgentSessionContext) =>
  queueSlot.get(ctx).verified ? "The caller is verified." : "The caller is NOT verified.";

export const gated = agent({
  name: "Gated desk",
  systemPrompt: perRequest satisfies AgentSystemPrompt,
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
//    is a promise about all of it, and a fixture that names one signature
//    freezes one signature (`api-contracts-gate.test.ts`).

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

// ─── The field groups as standalone VALUES, spread in ──────────────────────
//
// From the tool-call-speech branch's own epoch-3 example, kept in the union
// because it is the one PATTERN the other three did not exercise: each field
// group built as a typed value and spread into `agent()`, rather than written
// flat. `minTurnSilenceMs` is inline here for the same reason — the other arm
// reaches it through `assemblyAIPipeline()`, and an epoch-3 author had both
// routes to it.
const spreadLimits: UsageLimits = { totalTokens: 200_000 };
const spreadTuning: AgentModelTuning = {
  temperature: 0.4,
  maxOutputTokens: 512,
  usageLimits: spreadLimits,
};
const noWholesale: AgentGuardrail = (text) =>
  text.includes("wholesale") ? "I can't discuss wholesale pricing." : true;
const spreadGuardrails: AgentGuardrails = { inputGuardrails: [noWholesale] };
const spreadObservation: AgentObservation = {
  events: { "user-transcript.committed": () => undefined },
};
const houseRules: AgentSystemPrompt = (ctx: AgentSessionContext) =>
  `You are the support line for a bicycle shop. Session ${ctx.sessionId}.`;

export const spreadDesk = agent({
  name: "Bike Support",
  greeting: "Bike shop, how can I help?",
  systemPrompt: houseRules,
  minTurnSilenceMs: 1600,
  ...spreadTuning,
  ...spreadGuardrails,
  ...spreadObservation,
});
