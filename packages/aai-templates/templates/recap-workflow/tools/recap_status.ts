import { tool, type WorkflowRunOf } from "@alexkroman1/aai";
import { isTerminal } from "@alexkroman1/aai/workflow-api";
import { recap } from "../shared.ts";

/** How many past runs the status tool will look at. Newest first. */
const RECENT_RUNS = 3;

/**
 * One line a voice agent can read aloud about a run.
 *
 * This is the QUERY, and `isTerminal` is what makes it typed: it narrows to the
 * three finished statuses, which is what puts `run.output` and `run.error`
 * within reach without a cast. `WorkflowRunOf` is the snapshot with that output
 * already named from the declaration — the
 * `WorkflowRunSnapshot<WorkflowOutputOf<typeof recap>>` this file used to
 * compose by hand, for a three-name import — so the signature never reaches past
 * the declaration into the body, and it is still the discriminated union.
 */
function describeRun(run: WorkflowRunOf<typeof recap>): string {
  if (!isTerminal(run)) return "Still working on that one.";
  switch (run.status) {
    case "completed": {
      // The gate's outcome is part of the answer: a caller who never got round
      // to answering should hear that the transcript is gone, not just the recap.
      const fate = run.output.kept ? "transcript kept" : "transcript deleted";
      return `Done: ${run.output.spoken} (${fate})`;
    }
    case "failed":
      // The run compensated before it failed — see `workflows/recap.ts` — so
      // there is nothing left to clean up and nothing for the caller to do
      // beyond asking again.
      return `That one failed and was rolled back: ${run.error}`;
    default:
      return "That one was cancelled.";
  }
}

export default tool({
  description: "Report on recaps started earlier in this call.",
  execute: async (_args, ctx) => {
    const runs = await ctx.workflows.find(recap, ctx.sessionId, { limit: RECENT_RUNS });
    if (runs.length === 0) return { runs: [] as string[], note: "Nothing started yet." };
    return { runs: runs.map(describeRun) };
  },
});
