// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 18.
 *
 * The DECLARATION itself, one per arm of the params union: a clinic's voice
 * front desk (`agent()` on the pipeline arm — the AssemblyAI preset, the
 * turn-taking tuning, an MCP server, and the session-event handlers that keep
 * the desk's own log), its after-hours S2S line, its text chat widget, and its
 * intake form (`workflowApp()`, whose front door is a form rather than a
 * microphone). In a real project those are four `agent.ts` files in four
 * directories; they sit together here because the capability under test is the
 * declaration, and its parameter type is a union of exactly these four shapes.
 * Written the way it was authored at epoch 18, and it must keep compiling for as
 * long as that epoch is advertised as supported.
 *
 * ## What moved, and why epoch 18 survives it
 *
 * Nothing this capability exports. `aai:agent`'s list is byte-identical across
 * the bump — `agent`, `workflowApp`, `AgentDef`, the four params arms,
 * `assemblyAIPipeline`, the six `Mcp*` names, the four `SessionEvent*` names,
 * `ToolChoice`, `BuiltinTool`, the two provider base types — and the report hash
 * moved because `WorkflowBody`'s second parameter type was renamed
 * `WorkflowCtx` -> `WorkflowContext`.
 *
 * **This capability owns the field the renamed type arrives through**, which is
 * why the example goes as far as declaring the workflow app rather than stopping
 * at the voice agent. `AgentDef.workflows` is a map of `WorkflowDef`s and
 * `workflowApp()` REQUIRES one, so a `WorkflowBody` — and therefore its `ctx`
 * parameter type — is in this report by construction, not by an accident of
 * rollup depth.
 *
 * It still cannot break {@link intake} below. A body's second parameter is
 * INFERRED from `workflow({ run })`: the declaration states the input schema and
 * the body reads `ctx.step`, `ctx.now` and `ctx.sleep` off a parameter it never
 * annotates. That is how every template writes one, and it is what makes this a
 * retain rather than a drop — the type is in the report and in no line of the
 * example.
 *
 * **The directions that WOULD break this file** are the ones the params union
 * exists to police, and they are not renames: the misuse arms losing a case, so
 * `voice` alongside the preset's own `tts` stops being an error; `workflowApp()`
 * accepting `page` again, which it exists to have already set;
 * {@link SessionEventHandlers} rekeying off the wire union, which would make
 * {@link deskEvents}'s two literal keys unassignable — the failure that
 * capability's own doc records as having shipped as a `patch`.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 18 has to be dropped with a reason.
 */

import { z } from "zod";
import {
  type AgentDef,
  type AgentParams,
  type AssemblyAIPipelineOptions,
  agent,
  assemblyAIPipeline,
  assemblyAIS2s,
  type BuiltinTool,
  MCP_SERVER_KEY_RE,
  MCP_TOOL_NAME_MAX,
  MCP_TOOL_PREFIX,
  type McpServerConfig,
  type McpServers,
  mcpToolName,
  type PipelineAgentParams,
  type PipelineVoiceTuning,
  type ProviderCredentialOptions,
  type ProviderDescriptor,
  pushCapped,
  type S2sAgentParams,
  type SessionEventContext,
  type SessionEventHandler,
  type SessionEventHandlers,
  type SessionEventType,
  type SharedAgentParams,
  type StaticAgentParams,
  sessionSlot,
  type TextAgentParams,
  type ToolChoice,
  workflow,
  workflowApp,
} from "../../../index.ts";

/**
 * ── EDIT: the three stages, from the preset. ─────────────────────────────
 *
 * `assemblyAIPipeline()` rather than three descriptors: one key for all three
 * stages, and the two endpointing numbers land where the STT stage reads them.
 * Setting them on the agent instead is a compile error whenever an explicit
 * `stt` descriptor is present, which is exactly the case a spread creates.
 */
const pipelineOptions: AssemblyAIPipelineOptions = {
  voice: "michael",
  region: "eu",
  // The pause a caller is allowed before the turn is force-ended. The MINIMUM
  // is the latency floor on every finished utterance and is left at its
  // measured default; this is the one that decides how patient the desk is.
  maxTurnSilenceMs: 3000,
};

/**
 * ── EDIT: which builtins this desk may call. ─────────────────────────────
 *
 * Nothing is on by default and every builtin is opt-in by name, so the list is
 * the whole declaration. `as const satisfies` keeps the names checked against
 * the union rather than widening to `string[]`.
 */
const deskBuiltins = ["think", "calculate"] as const satisfies readonly BuiltinTool[];

/** The default, stated: the model decides when a tool is worth calling. A
 *  `"required"` desk cannot answer a question that needs no lookup. */
const deskToolChoice: ToolChoice = "auto";

/**
 * ── EDIT: the MCP servers whose tools this desk may relay. ───────────────
 *
 * `tokenEnv` names the variable the token is read from rather than carrying the
 * token, which is what keeps a credential out of a config that is stored and
 * out of a file that is committed. `pinnedTools` fixes the name the model calls
 * a remote tool by, so a server that renames one does not silently change this
 * agent's tool surface.
 */
const chartsServer: McpServerConfig = {
  url: "https://charts.example.com/mcp",
  tokenEnv: "CHARTS_MCP_TOKEN",
  pinnedTools: { patient_chart: "getPatientChart" },
};

const deskServers: McpServers = { charts: chartsServer };

/**
 * Refuse a server key the grammar does not allow, at declaration time.
 *
 * The regex is exported so an agent that builds its server map from
 * configuration checks the key with the same rule the framework will, rather
 * than finding out at deploy.
 */
export function assertServerKey(key: string): void {
  if (!MCP_SERVER_KEY_RE.test(key)) {
    throw new Error(`"${key}" is not a usable MCP server key.`);
  }
}

/**
 * What the model will call a relayed tool, for the desk's own audit line.
 *
 * Derived rather than restated: `mcpToolName` is the framework's own rule, and
 * the two constants are what make a name that is going to be TRUNCATED
 * predictable to whoever reads the log.
 */
export function auditName(serverKey: string, remoteName: string): string {
  const name = mcpToolName(serverKey, remoteName);
  const trimmed = name.length === MCP_TOOL_NAME_MAX ? " (at the cap)" : "";
  return `${name}${trimmed} [${MCP_TOOL_PREFIX}${serverKey}]`;
}

/** ── EDIT: the desk's own log, so the handlers below have somewhere to write. ── */
const logSlot = sessionSlot("desk-log", () => ({ lines: [] as string[] }));

/** How many lines the log keeps; it crosses the wire on every projection. */
const MAX_LINES = 40;

/**
 * A handler extracted from the literal, which is the first thing that happens
 * once one grows past a line.
 *
 * `SessionEventHandler` with no type parameter is handed the whole wire union,
 * which is what the `"*"` key needs — it runs for every event, after the typed
 * handler for that event.
 */
const logEverything: SessionEventHandler = (event, ctx) => {
  logSlot.update(ctx, (log) => {
    pushCapped(log.lines, event.type, MAX_LINES);
  });
};

/**
 * The names this desk audits, as a list a reviewer can read.
 *
 * `SessionEventType` is the KEY SET of the handler map, named so it can be
 * written down in the agent's own code — the union is otherwise only readable
 * as the event schema's rendered type.
 */
export const AUDITED: readonly SessionEventType[] = ["tool.called", "error.reported"];

/**
 * What a handler is allowed to do, in one function.
 *
 * `SessionEventContext` carries `slots` and `sessionId` and no `send`, no
 * `generate` and no `messages` — a hook maintains the session's own state and
 * cannot decide what the agent says. The write is SYNCHRONOUS because the
 * commit happens after the handler returns.
 */
export function note(ctx: SessionEventContext, line: string): void {
  logSlot.update(ctx, (log) => {
    pushCapped(log.lines, line, MAX_LINES);
  });
}

/**
 * ── EDIT: the handlers themselves. ───────────────────────────────────────
 *
 * Typed as {@link SessionEventHandlers}, so each key is checked against the
 * wire union and each handler's `event` is narrowed to that event's own shape —
 * `toolName` on one, the reported error on the other, with no cast.
 */
const deskEvents: SessionEventHandlers = {
  "tool.called": (event, ctx) => note(ctx, `called ${event.toolName}`),
  "error.reported": (event, ctx) => note(ctx, `error: ${event.message}`),
  "*": logEverything,
};

/**
 * ── EDIT: the fields every front door below shares. ─────────────────────
 *
 * {@link SharedAgentParams} is the half of the declaration that is not about a
 * mode, so a clinic running four front doors states what they agree on once. A
 * `Pick` rather than the whole type: each arm below supplies the rest, and a
 * shared bag must not claim a field one of them types as a misuse message —
 * which is also why `name` and `greeting` are not in here, being per front
 * door.
 */
const clinic: Pick<SharedAgentParams, "systemPrompt" | "requiredEnv"> = {
  systemPrompt:
    "You are the front desk of a small clinic. Check people in, answer questions " +
    "about their appointment, and say when you do not know something.",
  // Checked at deploy time, so a missing key fails there rather than on the
  // first call that reaches the chart server.
  requiredEnv: ["CHARTS_MCP_TOKEN"],
};

/**
 * ── EDIT: how this desk behaves when a turn goes wrong. ─────────────────
 *
 * {@link PipelineVoiceTuning} is the pipeline-only half, named as its own bag
 * because these are the fields that get tuned against real calls and reviewed
 * together. `errorPhrase` is what the caller hears when a turn's LLM stream
 * fails, which is otherwise silence; the barge-in floor is what stops a
 * one-word backchannel cutting the desk off mid-sentence.
 */
const deskTuning: PipelineVoiceTuning = {
  errorPhrase: "Sorry, I lost that. Could you say it again?",
  minBargeInWords: 2,
  resumeFalseInterruption: true,
};

/**
 * ── EDIT: where this clinic keeps its AssemblyAI key. ───────────────────
 *
 * {@link ProviderCredentialOptions} is the base every provider options
 * interface on every stage extends, which is what makes `apiKeyEnv` one field
 * rather than four spellings of one. Named here so the after-hours line's
 * descriptor repoints its credential without the variable being written out at
 * the call site.
 */
const credential: ProviderCredentialOptions = { apiKeyEnv: "CLINIC_ASSEMBLYAI_KEY" };

/**
 * Which vendor a stage is on, for this project's own boot line.
 *
 * {@link ProviderDescriptor} is the shape all four stages narrow, so a helper
 * that only wants the vendor tag takes the base and works for any of them —
 * where naming a stage's own alias would make this four functions.
 */
export function stageKind(descriptor: ProviderDescriptor<string, Record<string, unknown>>): string {
  return descriptor.kind;
}

/**
 * ── EDIT: the voice agent. ───────────────────────────────────────────────
 *
 * Annotated as {@link PipelineAgentParams} rather than passed inline, which is
 * what a declaration this long ends up as: the arm is named, so a field that
 * belongs to another mode fails against the arm's own message instead of
 * against a printed union of all four.
 *
 * There is no `tools` key, and there cannot be one — a tool IS a file, so
 * `tools/check_in.ts` that default-exports `tool({ … })` is the tool
 * `check_in`, registered by existing.
 */
const deskParams: PipelineAgentParams = {
  ...clinic,
  ...deskTuning,
  name: "Clinic Front Desk",
  greeting: "Clinic front desk — how can I help?",
  ...assemblyAIPipeline(pipelineOptions),
  builtinTools: deskBuiltins,
  toolChoice: deskToolChoice,
  mcpServers: deskServers,
  events: deskEvents,
  syncState: logSlot.projection((log) => ({ lines: log.lines })),
  maxSteps: 8,
};

export const frontDesk: AgentDef = agent(deskParams);

/**
 * ── EDIT: the after-hours line. ──────────────────────────────────────────
 *
 * The S2S arm. Every pipeline field is typed as a misuse MESSAGE here rather
 * than merely absent — STT, the model loop and TTS all run service-side, so
 * `llm` or `deadAirCoverMs` beside `s2s` is a compile error naming the reason
 * instead of a setting that silently does nothing. `voice` likewise: it rides
 * on the descriptor, which is where this one sets it.
 */
const afterHoursParams: S2sAgentParams = {
  ...clinic,
  name: "Clinic After Hours",
  greeting: "Clinic after-hours line.",
  s2s: assemblyAIS2s({ ...credential, voice: "jane" }),
  maxSteps: 4,
};

export const afterHours: AgentDef = agent(afterHoursParams);

/** The vendor behind the after-hours line, read through the shared base. */
export const afterHoursVendor: string = stageKind(afterHoursParams.s2s);

/**
 * ── EDIT: the web widget. ────────────────────────────────────────────────
 *
 * The TEXT arm — an LLM, a prompt and the same tools, run over a message list
 * with no audio path at all. `text: true` is an explicit opt-in for the same
 * reason `s2s` is: a mode nothing can reach by omission cannot be reached by
 * accident, and `stt`/`tts` are refused here by name.
 */
const widgetParams: TextAgentParams = {
  ...clinic,
  name: "Clinic Chat",
  greeting: "Clinic chat — how can I help?",
  text: true,
  llm: "claude-sonnet-4-6",
  maxSteps: 8,
};

export const widget: AgentDef = agent(widgetParams);

/**
 * ── EDIT: this project's own front door for declaring one. ──────────────
 *
 * {@link AgentParams} is the union of all four arms, which is what lets a
 * project keep one factory every `agent.ts` goes through — for a shared
 * registry, a boot log, or the assertion that follows. A function taking the
 * union costs nothing at the call sites: each arm still checks its own fields,
 * because the union is discriminated by them.
 */
export function declare(params: AgentParams): AgentDef {
  return agent(params);
}

/**
 * ── EDIT: the work the intake form does. ─────────────────────────────────
 *
 * The `ctx` parameter is the whole of the "what moved" note above: it is
 * inferred from this declaration, so the body reads three of its methods and
 * names its type nowhere.
 *
 * `sleep` is LABELLED, and the label is part of the key — a body reaching a
 * different number of waits on replay would otherwise read another wait's
 * record. `now()` is journaled for the same reason: a replay must see the
 * time the first walk saw.
 */
export const intake = workflow({
  description: "File a new patient's intake form and hold it for the nurse's review",
  input: z.object({
    patient: z.string().max(80),
    reason: z.string().max(400),
  }),
  run: async (input, ctx) => {
    const filedAt = await ctx.now();
    const record = await ctx.step("file", () => ({
      patient: input.patient,
      reason: input.reason,
      filedAt,
    }));
    // The nurse's review window. A run asleep here costs nothing and survives a
    // redeploy, which is the whole reason this is a workflow app rather than a
    // form that posts somewhere.
    await ctx.sleep("review-window", filedAt + 15 * 60 * 1000);
    return { ...record, reviewed: true };
  },
});

/**
 * The intake app — `agent({ page: "static" })` with the discriminant already
 * set, so the mode is the CALL rather than a field to remember.
 *
 * The fields such an app has no use for are typed as misuse messages rather
 * than merely omitted: no providers, no `systemPrompt`, no voice tuning, because
 * nothing talks and no model runs — `greeting` is the one client-config field a
 * page can still use and stays declarable. `workflows` is REQUIRED, an app whose
 * whole API is `/workflows/*` and which declares none being a form that 400s on
 * every submit. It answers with the same {@link AgentDef} `agent()` does — one
 * definition type, one config, one deploy path.
 */
const intakeParams: Omit<StaticAgentParams, "page"> = {
  name: "Clinic Intake",
  workflows: { intake },
  requiredEnv: ["ASSEMBLYAI_API_KEY"],
};

export const intakeApp: AgentDef = workflowApp(intakeParams);
