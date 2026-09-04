// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 20.
 *
 * A support line as it was declared at epoch 20: the AssemblyAI preset for all
 * three stages, the builtins it may call, the MCP server whose tools it relays,
 * and the session-event handlers that keep its own log — plus the workflow app
 * beside it, because `workflowApp()` is the fourth arm of the same parameter
 * union and a change to that union has to fail against both.
 *
 * ## What moved, and why epoch 20 survives it
 *
 * `AgentDef` gained one OPTIONAL field — `telephony`, the carrier allow-list
 * that decides whether the agent serves `WS /phone` — and the capability gained
 * the two types it is written in (`TelephonyAccess`, `TelephonyCarrier`). The
 * export list grew; nothing in it changed shape.
 *
 * So epoch 20 survives by being the case the field was designed around: an
 * agent that declares nothing about phone calls. What such an agent GETS
 * changed underneath this file — the route used to be mounted for any voice
 * agent and is now mounted for none that has not asked — and that is the point
 * of freezing this one rather than a declaration with the new field in it.
 * Everything here is still legal, and {@link desk} is exactly the agent whose
 * `/phone` went away.
 *
 * **The directions that WOULD break this file** are the ones the params union
 * exists to police: `telephony` becoming REQUIRED, or narrowing to something a
 * voice agent cannot spell; the misuse arms losing a case, so `voice` alongside
 * the preset's own `tts` stops being an error; `workflowApp()` accepting `page`
 * again, which it exists to have already set; {@link SessionEventHandlers}
 * rekeying off the wire union, which would make {@link deskEvents}'s literal
 * keys unassignable.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 20 has to be dropped with a reason.
 */

import { z } from "zod";
import {
  type AgentDef,
  type AgentParams,
  type AssemblyAIPipelineOptions,
  agent,
  assemblyAIPipeline,
  type BuiltinTool,
  MCP_TOOL_PREFIX,
  type McpServers,
  mcpToolName,
  type PipelineAgentParams,
  type SessionEventHandlers,
  type ToolChoice,
  workflow,
  workflowApp,
} from "../../../index.ts";

/**
 * ── EDIT: the three stages, from the preset. ─────────────────────────────
 *
 * One key for all three stages, and the pause tolerance lands where the STT
 * stage reads it. Setting it on the agent instead is a compile error whenever
 * an explicit `stt` descriptor is present.
 */
const pipelineOptions: AssemblyAIPipelineOptions = {
  voice: "michael",
  maxTurnSilenceMs: 3000,
};

/** ── EDIT: which builtins this desk may call. Nothing is on by default. ── */
const deskBuiltins = ["think", "calculate"] as const satisfies readonly BuiltinTool[];

/** The default, stated: a desk that must call a tool cannot answer a greeting. */
const deskToolChoice: ToolChoice = "auto";

/**
 * ── EDIT: the MCP server whose tools this desk relays. ───────────────────
 *
 * `tokenEnv` names the variable the token is read from rather than carrying the
 * token, which keeps a credential out of a config that is stored. `pinnedTools`
 * is the reviewed baseline: the fingerprint each relayed tool had when a human
 * read it, so a server that changes one afterwards is a finding rather than a
 * silent change to this agent's tool surface. The name the model calls it by is
 * derived below rather than written down.
 */
const deskMcp: McpServers = {
  tickets: {
    url: "https://mcp.example.com/tickets",
    tokenEnv: "TICKETS_MCP_TOKEN",
    pinnedTools: { open_ticket: "sha256:3f0c9a" },
  },
};

/** What the model calls the pinned tool — `tickets__open_ticket`. */
export const openTicketToolName: string = mcpToolName("tickets", "open_ticket");

/** And the separator that name is built from, quoted where a log parses it. */
export const mcpPrefixSeparator: string = MCP_TOOL_PREFIX;

/**
 * ── EDIT: what the desk records about its own session. ───────────────────
 *
 * Handlers are keyed by the wire event name, so a key that is not one is a
 * compile error rather than a handler that never runs.
 */
const deskEvents: SessionEventHandlers = {
  "tool.called": (event) => console.error(`desk tool ${event.toolName}`),
  "error.reported": (event) => console.error(`desk error ${event.message}`),
};

/** The declaration, as the pipeline arm of the union sees it. */
const deskParams: PipelineAgentParams = {
  name: "Clinic Desk",
  systemPrompt: "You are the clinic's front desk. Be brief.",
  greeting: "Clinic front desk — how can I help?",
  ...assemblyAIPipeline(pipelineOptions),
  builtinTools: deskBuiltins,
  toolChoice: deskToolChoice,
  mcpServers: deskMcp,
  events: deskEvents,
};

/** …and as the union `agent()` actually takes. */
const asParams: AgentParams = deskParams;

/** The desk. No `telephony`, which at this epoch was not a field at all. */
export const desk: AgentDef = agent(asParams);

/** The intake form beside it: same union, other arm, no session at all. */
export const intake: AgentDef = workflowApp({
  name: "Clinic Intake",
  workflows: {
    submit: workflow({
      description: "Record an intake form.",
      input: z.object({ name: z.string(), reason: z.string() }),
      run: ({ name, reason }) => ({ filed: `${name}: ${reason}` }),
    }),
  },
});
