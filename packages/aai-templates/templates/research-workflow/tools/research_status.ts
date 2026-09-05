import { tool, type WorkflowRunOf } from "@alexkroman1/aai";
import { plural } from "@alexkroman1/aai/utils";
import { isTerminal } from "@alexkroman1/aai/workflow-api";
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
  if (!isTerminal(run)) return "Still working on it.";
  switch (run.status) {
    case "completed":
      return `Done: ${run.output.summary} (${run.output.sources} ${plural(run.output.sources, "source")})`;
    case "failed":
      return `That one failed: ${run.error}`;
    default:
      return "That one was cancelled.";
  }
}

export default tool({
  description: "Report on research started earlier in this call.",
  execute: async (_args, ctx) => {
    const runs = await ctx.workflows.find(research, ctx.sessionId, { limit: RECENT_RUNS });
    if (runs.length === 0) return { runs: [] as string[], note: "Nothing started yet." };
    return { runs: runs.map((run) => `${run.workflow}: ${describeRun(run)}`) };
  },
});
