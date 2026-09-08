import { tool, type WorkflowRunOf } from "@alexkroman1/aai";
import { plural } from "@alexkroman1/aai/utils";
import {
  isTerminal,
  type TerminalWorkflowRun,
  type WorkflowOutputOf,
  type WorkflowRunBase,
} from "@alexkroman1/aai/workflow-api";
import { research } from "../shared.ts";

/** How many past runs the status tool will look at. Newest first. */
const RECENT_RUNS = 3;

/**
 * One line a voice agent can read aloud about a run.
 *
 * `WorkflowRunOf` is the snapshot with its output already typed — the
 * `WorkflowRunSnapshot<WorkflowOutputOf<typeof research>>` this file used to
 * compose by hand, which cost a three-name import for one type. Still the
 * discriminated union, so `isTerminal` below narrows exactly as it did.
 */
function describeRun(run: WorkflowRunOf<typeof research>): string {
  // `isTerminal` narrows to the three finished statuses, which is what makes
  // `run.output` and `run.error` reachable without a cast.
  return isTerminal(run) ? describeFinished(run) : "Still working on it.";
}

/**
 * The half of {@link describeRun} that reads a FINISHED run.
 *
 * The parameter type is what the guard bought, said out loud:
 * `TerminalWorkflowRun` is the three statuses that carry an outcome, so the
 * `switch` below reaches `output` and `error` with nothing narrowing it here
 * and no `default` that means "impossible".
 */
function describeFinished(run: TerminalWorkflowRun<WorkflowOutputOf<typeof research>>): string {
  switch (run.status) {
    case "completed":
      return `Done: ${run.output.summary} (${run.output.sources} ${plural(run.output.sources, "source")})`;
    case "failed":
      return `That one failed: ${run.error}`;
    default:
      return "That one was cancelled.";
  }
}

/**
 * When the caller asked for it, in words a phone can carry.
 *
 * `WorkflowRunBase` is the half of a snapshot that every status shares, and
 * naming it here says this reads nothing status-specific — the line is the same
 * whether the run finished or is still going. It replaces `run.workflow`, which
 * prefixed every line with the string "research": true, and read aloud as noise
 * on a desk that only runs one workflow. What a caller ringing back needs is
 * WHICH of their requests this is, and the only thing distinguishing two of them
 * is when they asked.
 */
function askedAt(run: WorkflowRunBase): string {
  const minutes = Math.round((Date.now() - run.createdAt) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} ${plural(minutes, "minute")} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} ${plural(hours, "hour")} ago`;
}

export default tool({
  description: "Report on research started earlier in this call.",
  execute: async (_args, ctx) => {
    const runs = await ctx.workflows.find(research, ctx.sessionId, { limit: RECENT_RUNS });
    if (runs.length === 0) return { runs: [] as string[], note: "Nothing started yet." };
    return { runs: runs.map((run) => `${askedAt(run)}: ${describeRun(run)}`) };
  },
});
