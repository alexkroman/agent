// Copyright 2026 the AAI authors. MIT license.
/**
 * The `workflow_status` builtin — how a VOICE agent talks about its own durable
 * work.
 *
 * A tool starts a run and answers the turn ("working on it"), and then the
 * conversation continues. The caller's next question is "is it ready yet?", and
 * before this there was no way for the model to answer it: `ctx.workflows.get`
 * needs a `runId`, the natural place a tool puts one is `ctx.state`, and
 * per-session state is swept `SESSION_RESUME_GRACE_MS` after the call ends. So
 * the run outlived the session and the handle to it did not — every agent that
 * wanted this had to build its own run index in `ctx.db`.
 *
 * What closed that is the correlation key (`StartOptions.key`): a run started
 * with `key: ctx.sessionId` is findable again for as long as the journal keeps
 * it. This builtin is the read side, and it is scoped to the CURRENT session's
 * key by construction — the model chooses which workflow to ask about, never
 * whose runs to look at, so it cannot be talked into reading another caller's
 * work.
 *
 * It is opt-in by name like every other builtin
 * (`agent({ builtinTools: ["workflow_status"] })`), and it only reports runs
 * whose `start` passed a key. A run started without one is deliberately
 * invisible here: an unkeyed run belongs to a page holding its own `runId`, not
 * to a conversation.
 */

import { z } from "zod";
import type { ToolDef } from "../sdk/types.ts";
import { isTerminal, type WorkflowRunSnapshot } from "../sdk/workflow.ts";

/**
 * Runs reported per workflow.
 *
 * Small because the audience is a spoken reply: an agent listing ten background
 * jobs is not answering the question that was asked, and the newest few are what
 * "is it ready?" means. `find` orders newest first, so this takes the useful end.
 */
export const MAX_WORKFLOW_STATUS_RUNS = 5;

/**
 * Longest `output` this reports per completed run, in characters of JSON.
 *
 * A completed run's output can be a whole transcript, and the tool result is
 * spoken material heading into the model's context. Truncation is REPORTED rather
 * than silent (`…truncated`), because a model handed a clipped JSON document
 * otherwise treats it as the whole answer.
 */
export const MAX_WORKFLOW_STATUS_OUTPUT_CHARS = 1200;

const workflowStatusParams = z.object({
  workflow: z
    .string()
    .optional()
    .describe("Name of the workflow to check. Omit to check every workflow this agent declares."),
});

/** One run, as the model should read it. */
type RunReport = {
  workflow: string;
  runId: string;
  status: WorkflowRunSnapshot["status"];
  stepsCompleted: number;
  finished: boolean;
  output?: unknown;
  error?: string;
  resumesInSeconds?: number;
};

/** Clip a completed run's output so one finished run cannot fill the context. */
function reportedOutput(output: unknown): unknown {
  const json = JSON.stringify(output ?? null);
  if (json.length <= MAX_WORKFLOW_STATUS_OUTPUT_CHARS) return output;
  return `${json.slice(0, MAX_WORKFLOW_STATUS_OUTPUT_CHARS)}… (truncated; ${json.length} characters total)`;
}

/**
 * Snapshot → what the model reads.
 *
 * `finished` is stated explicitly alongside `status` because it is the thing the
 * caller asked and the thing a model most often gets wrong from a status name —
 * "sleeping" is not finished, and "cancelled" is.
 *
 * A sleeping run reports SECONDS FROM NOW rather than its epoch `wakeAt`: an
 * absolute millisecond timestamp is not something a model can turn into "about
 * two minutes" reliably, and this tool exists to be spoken.
 */
function toReport(run: WorkflowRunSnapshot): RunReport {
  const base = {
    workflow: run.workflow,
    runId: run.runId,
    status: run.status,
    stepsCompleted: run.stepsCompleted,
    finished: isTerminal(run),
  };
  switch (run.status) {
    case "completed":
      return { ...base, output: reportedOutput(run.output) };
    case "failed":
      return { ...base, error: run.error };
    case "sleeping":
      return {
        ...base,
        resumesInSeconds: Math.max(0, Math.round((run.wakeAt - Date.now()) / 1000)),
      };
    default:
      return base;
  }
}

/**
 * Check on durable work this conversation started.
 *
 * @internal
 */
export function createWorkflowStatus(): ToolDef<typeof workflowStatusParams> & {
  guidance: string;
} {
  return {
    guidance:
      "Use workflow_status to check on background work you started earlier in this " +
      "conversation before telling the caller whether it is done.",
    description:
      "Check the status of background work started earlier in this conversation. " +
      "Reports each run's progress, and its result once it has finished.",
    inputSchema: workflowStatusParams,
    execute: async ({ workflow }, ctx) => {
      // Naming one workflow narrows the read; omitting it asks about all of them,
      // which is what a caller's "is it ready?" actually means when an agent
      // declares more than one. The names come from the engine rather than the
      // model, so an unknown one is a rejected `find` rather than a silent empty.
      const names = workflow ? [workflow] : ctx.workflows.listing().map((w) => w.name);
      if (names.length === 0) {
        return { error: "This agent declares no workflows, so nothing runs in the background." };
      }
      const reports: RunReport[] = [];
      for (const name of names) {
        // Scoped to THIS session's key — the model picks the workflow, never the
        // key, so there is no argument that could reach another caller's runs.
        const runs = await ctx.workflows.find(name, ctx.sessionId, {
          limit: MAX_WORKFLOW_STATUS_RUNS,
        });
        for (const run of runs) reports.push(toReport(run));
      }
      if (reports.length === 0) {
        return "No background work has been started in this conversation yet.";
      }
      return { runs: reports };
    },
  };
}
