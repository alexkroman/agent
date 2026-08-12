// Copyright 2026 the AAI authors. MIT license.
/**
 * The after-action report: durable work a VOICE agent starts and does not wait for.
 *
 * Everything else in this template happens inside one call. This does not, and
 * that is the point of it being here: a dispatcher resolves an incident, asks for
 * the report, and hangs up — the drafting and filing continue in a run that
 * outlives the session, the sandbox that served it, and any redeploy in between.
 *
 * **The run's INPUT is the whole handoff, and it has to be, because a workflow
 * cannot read `ctx.state`.** Session state is swept `SESSION_RESUME_GRACE_MS`
 * after the caller hangs up, so a run that read the incident later would find
 * nothing. So the incident is SNAPSHOT into the input at start time — which is
 * also why the tool below is `startTool(…, { inputSchema, input })` rather than
 * the plain form: the model is asked for an incident id, and the snapshot is
 * assembled from state by code.
 *
 * **The report is answered by the model, not by a second tool.**
 * `builtinTools: ["workflow_status"]` (see `agent.ts`) lets the dispatcher ask
 * "is the report for four ready?" and get a real answer, because `startTool` keys
 * every run to `ctx.sessionId` by default and that builtin reads exactly that key.
 *
 * **Requires storage** (`aai storage enable <slug>`, the studio's Settings →
 * Database, or `DATABASE_URL` under `aai dev`) — the journal is what makes the
 * run durable, and the filed report is a row in the same schema. Without it the
 * agent still takes calls and manages incidents; only this tool fails, and it
 * fails by telling the model so rather than by breaking the session.
 */

import { isToolFailure, startTool, workflow } from "@alexkroman1/aai";
import { z } from "zod";
import { dispatchSlot, findIncident, logEvent } from "./shared.ts";

/**
 * How long the run waits before drafting.
 *
 * A review window rather than a delay for its own sake: units are still clearing
 * when an incident is marked resolved, and a report written in that minute
 * describes a scene that is still moving. Short enough to watch happen in a demo.
 *
 * This is what makes the workflow durable rather than merely asynchronous — a
 * `ctx.sleep` journals its wake time and RELEASES the run, so nothing is holding
 * a billed sandbox open across it.
 */
const REVIEW_WINDOW_MS = 60_000;

/** Timeline entries carried into the run. Capped: the input is journaled. */
const MAX_SNAPSHOT_EVENTS = 40;

const CREATE_TABLE = `create table if not exists after_action_reports (
  id bigserial primary key,
  run_id text not null unique,
  incident_id text not null,
  narrative text not null,
  created_at timestamptz not null default now()
)`;

/**
 * What the run needs, and nothing more.
 *
 * Every field here is re-read from the journal on every replay, so this is a
 * budget rather than a convenience: the caller's name and phone are deliberately
 * absent (the report does not need them, and PII in a journal outlives the call
 * that collected it), and the timeline is capped.
 */
const snapshot = z.object({
  incidentId: z.string().max(20),
  type: z.string().max(40),
  severity: z.string().max(20),
  location: z.string().max(200),
  description: z.string().max(2000),
  resourcesAssigned: z.number().int().min(0),
  timeline: z.array(z.string().max(200)).max(MAX_SNAPSHOT_EVENTS),
});

export const afterAction = workflow({
  description: "Draft and file the after-action report for a resolved incident",
  input: snapshot,
  async run(incident, ctx) {
    // Journals a wake time and unwinds the run — see REVIEW_WINDOW_MS. On the
    // way back the run replays from the top and this call returns normally.
    await ctx.sleep(REVIEW_WINDOW_MS);

    const narrative = await ctx.step("draft", async () => {
      const { text } = await ctx.generate({
        system:
          "You write after-action reports for an emergency dispatch center. " +
          "Be factual and terse. Cover what happened, what was dispatched, and " +
          "what to do differently. Never invent detail that is not in the timeline.",
        prompt: [
          `Incident ${incident.incidentId}: ${incident.type} (${incident.severity})`,
          `Location: ${incident.location}`,
          `Description: ${incident.description}`,
          `Units assigned: ${incident.resourcesAssigned}`,
          "Timeline:",
          ...incident.timeline.map((event) => `- ${event}`),
        ].join("\n"),
      });
      return text;
    });

    await ctx.step("file", async () => {
      await ctx.db.query(CREATE_TABLE);
      // `on conflict (run_id)` is the cheap half of at-least-once: a replay of
      // this step cannot file the report twice.
      await ctx.db.query(
        `insert into after_action_reports (run_id, incident_id, narrative)
         values ($1, $2, $3)
         on conflict (run_id) do update set narrative = excluded.narrative`,
        [ctx.runId, incident.incidentId, narrative],
      );
      return { filed: ctx.runId };
    });

    // What `workflow_status` reports as the run's output, so it is shaped for
    // being READ ALOUD: a dispatcher wants to hear that it is filed and how long
    // it is, not a wall of narrative.
    return {
      incidentId: incident.incidentId,
      words: narrative.split(/\s+/).filter(Boolean).length,
      narrative,
    };
  },
});

/**
 * The tool that starts one.
 *
 * The narrow `inputSchema` is the whole reason this is not the plain
 * `startTool(afterAction, { description })`: the workflow's input is a
 * seven-field snapshot, and only the incident id is a question anyone can answer.
 */
export const requestAfterAction = startTool(afterAction, {
  description:
    "File an after-action report for a resolved incident. The report is written " +
    "in the background and survives the end of this call — ask about its status later.",
  inputSchema: z.object({
    incidentId: z.string().max(20).describe("The incident ID, e.g. INC-0004"),
  }),
  input: ({ incidentId }, ctx) => {
    // Read through the slot exactly as a tool does, because that is what this is
    // — the mapper runs inside the tool call, with the live session in hand.
    const state = dispatchSlot.get(ctx);
    const inc = findIncident(state, incidentId);
    // A failure here has to THROW rather than return: the host records a thrown
    // tool error for the model to read, whereas returning a `ToolFailure` from a
    // mapper would be handed to `start()` as the run's input.
    if (isToolFailure(inc)) throw new Error(inc.error);
    logEvent(inc, "After-action report requested");
    return {
      incidentId: inc.id,
      type: inc.type,
      severity: inc.severity,
      location: inc.location,
      description: inc.description,
      resourcesAssigned: inc.assignedResources.length,
      timeline: inc.timeline.slice(-MAX_SNAPSHOT_EVENTS).map((entry) => entry.event),
    };
  },
});
