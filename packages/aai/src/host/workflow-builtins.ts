// Copyright 2026 the AAI authors. MIT license.
/**
 * The three run builtins — `workflow_status`, `workflow_progress`,
 * `workflow_cancel` — the tools every voice agent with a durable workflow
 * wrote by hand, and the `workflow_status` the `WorkflowClient` docs promised
 * before it existed.
 *
 * Each is keyed by the SESSION: the caller on the phone asks about "that
 * thing I started", which is the run their session started, so the key is
 * `ctx.sessionId` — the default a tool's `start` records (`StartOptions.key`).
 * An optional `workflow` argument narrows to one declared workflow; omitted,
 * every workflow the agent declares is read (`findByKey`).
 *
 * What is SAID is the author's: `WorkflowDef.describeRun` is the line per run
 * and `WorkflowDef.cancelNote` the line after a cancel, with a plain sentence
 * per status behind each (`describeRun` in `sdk/workflow.ts`). The two
 * sentences a model should not have to compose — "already finished" and
 * "nothing started yet" — are baked in, so the agent answers them the same way
 * on every call.
 *
 * Built from the agent's declared workflows (`BuiltinToolOptions.workflows`),
 * handed in by the runtime's builtin surface, because `ctx.workflows.listing()`
 * carries names and schemas and not the describer; without the record, every
 * line falls back to the status sentence, which is still an answer.
 *
 * @internal
 */

import { z } from "zod";
import type { ToolContext } from "../sdk/tool-context.ts";
import type { ToolDef } from "../sdk/types.ts";
import { type AnyWorkflowDef, describeRun } from "../sdk/workflow.ts";
import type { WorkflowRunSnapshot } from "../sdk/workflow-run.ts";
import { builtinCover } from "./_builtin-cover.ts";

/** How many runs `workflow_status` lists — the most recent few, not a history. */
const STATUS_RUNS = 3;

/** The one argument all three take. */
const workflowParams = z.object({
  workflow: z
    .string()
    .min(1)
    .describe("Which workflow to ask about, by its declared name. Omit for every workflow.")
    .optional(),
});

/** The sentence for a caller whose session has started nothing. */
const NOTHING_STARTED = "Nothing has been started yet.";

/** The sentence for a cancel that found its run already over. */
const ALREADY_FINISHED = "That one had already finished.";

/** How many of the session's newest runs `workflow_cancel` reads to find the live one. */
const CANCEL_RUNS = 10;

/** One of the three: the tool plus the prompt line the builtin surface adds for it. */
type RunBuiltin = ToolDef<typeof workflowParams> & { guidance: string };

/** One run as the model reads it: the snapshot's facts plus the spoken line. */
type RunLine = {
  runId: string;
  workflow: string;
  status: WorkflowRunSnapshot["status"];
  line: string;
};

/** What the three builtins share: the declared defs, for the describer. */
type Declared = Readonly<Record<string, AnyWorkflowDef>> | undefined;

function lineOf(declared: Declared, run: WorkflowRunSnapshot): RunLine {
  return {
    runId: run.runId,
    workflow: run.workflow,
    status: run.status,
    line: describeRun(declared?.[run.workflow], run),
  };
}

/** The session's newest runs, of one workflow or of every one. */
async function recentRuns(
  ctx: ToolContext,
  workflow: string | undefined,
  limit: number,
): Promise<WorkflowRunSnapshot[]> {
  // Through the client's own string overloads, so an unknown `workflow` is the
  // client's refusal naming the declared set — a `WorkflowRequestError` the
  // model can recover from by asking differently.
  if (workflow !== undefined) return ctx.workflows.find(workflow, ctx.sessionId, { limit });
  return ctx.workflows.findByKey(ctx.sessionId, { limit, withOutput: false });
}

/**
 * The newest run of the session still going, read in one call over its newest
 * {@link CANCEL_RUNS} runs — or `NOT_STARTED` when it has none, so the caller
 * can tell "nothing to stop" from "nothing ever started" without a second read.
 */
async function newestLive(
  ctx: ToolContext,
): Promise<WorkflowRunSnapshot | undefined | typeof NOT_STARTED> {
  const runs = await ctx.workflows.findByKey(ctx.sessionId, {
    limit: CANCEL_RUNS,
    withOutput: false,
  });
  if (runs.length === 0) return NOT_STARTED;
  return runs.find((run) => run.status === "pending" || run.status === "running");
}

/** `newestLive`'s answer for a session that started nothing. */
const NOT_STARTED = Symbol("not started");

/**
 * The note when nothing is live: finished and never-started are different
 * answers to the caller, and for ONE workflow telling them apart takes the
 * read `live` did not make.
 */
async function nothingLive(ctx: ToolContext, workflow: string | undefined): Promise<string> {
  if (workflow === undefined) return ALREADY_FINISHED;
  const [latest] = await recentRuns(ctx, workflow, 1);
  return latest === undefined ? NOTHING_STARTED : ALREADY_FINISHED;
}

function createWorkflowStatus(declared: Declared): RunBuiltin {
  return {
    guidance:
      "When the caller asks how something they started is going, use workflow_status and " +
      "tell them the line it answers for the newest run, in your own words.",
    description:
      "List the most recent runs this caller started — newest first, at most " +
      `${STATUS_RUNS} — each with its status and a one-line description to say aloud. ` +
      "Pass a workflow name to ask about one workflow only.",
    inputSchema: workflowParams,
    messages: builtinCover("Let me check on that."),
    async execute(args, ctx) {
      const runs = await recentRuns(ctx, args.workflow, STATUS_RUNS);
      if (runs.length === 0) return { runs: [], note: NOTHING_STARTED };
      return { runs: runs.map((run) => lineOf(declared, run)) };
    },
  };
}

function createWorkflowProgress(declared: Declared): RunBuiltin {
  return {
    guidance:
      "When the caller asks what is happening right now with work in progress, use " +
      "workflow_progress and relay its line.",
    description:
      "The newest progress line the caller's latest run has written — what it is doing " +
      "right now — or its status line when it has written nothing yet. Pass a workflow " +
      "name to ask about one workflow only.",
    inputSchema: workflowParams,
    messages: builtinCover("Let me see where that's up to."),
    async execute(args, ctx) {
      const [run] = await recentRuns(ctx, args.workflow, 1);
      if (run === undefined) return { note: NOTHING_STARTED };
      const newest = await ctx.workflows.lastLine(run.runId);
      // The status line stands in for a run that has narrated nothing: a
      // `pending` run has no step to have written from.
      const line =
        newest === undefined ? describeRun(declared?.[run.workflow], run) : String(newest);
      return { runId: run.runId, workflow: run.workflow, status: run.status, line };
    },
  };
}

function createWorkflowCancel(declared: Declared): RunBuiltin {
  return {
    guidance:
      "When the caller asks to stop or call off work they started, use workflow_cancel and " +
      "repeat its note; never claim something was stopped when `cancelled` is false.",
    description:
      "Stop the caller's newest run that is still going. Answers { cancelled, note }: the note " +
      "says it was stopped, that it had already finished, or that nothing was started. Pass a " +
      "workflow name to stop a run of one workflow only.",
    inputSchema: workflowParams,
    messages: builtinCover("Let me stop that."),
    async execute(args, ctx) {
      // The newest LIVE run. For one workflow `live` answers it; across every
      // workflow ONE read of the session's newest runs is picked over locally,
      // so "nothing started" and "already finished" cost no second round trip.
      const live =
        args.workflow !== undefined
          ? await ctx.workflows.live(args.workflow, ctx.sessionId)
          : await newestLive(ctx);
      if (live === NOT_STARTED) return { cancelled: false, note: NOTHING_STARTED };
      if (live === undefined)
        return { cancelled: false, note: await nothingLive(ctx, args.workflow) };
      const cancelled = await ctx.workflows.cancel(live.runId);
      if (!cancelled) return { cancelled, note: ALREADY_FINISHED };
      const note = declared?.[live.workflow]?.cancelNote ?? `Stopped the ${live.workflow} run.`;
      return { cancelled, runId: live.runId, workflow: live.workflow, note };
    },
  };
}

/**
 * The three, keyed by builtin name, each built from the agent's declared
 * workflows.
 *
 * @internal
 */
export const WORKFLOW_BUILTINS: Record<
  string,
  (workflows?: Declared) => ToolDef & { guidance?: string }
> = {
  workflow_status: createWorkflowStatus,
  workflow_progress: createWorkflowProgress,
  workflow_cancel: createWorkflowCancel,
};
