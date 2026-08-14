import {
  isTerminal,
  tool,
  type WorkflowOutputOf,
  type WorkflowRunSnapshot,
} from "@alexkroman1/aai";
import { research } from "../shared.ts";

/** How many past runs the status tool will look at. Newest first. */
const RECENT_RUNS = 3;

/**
 * One line a voice agent can read aloud about a run.
 *
 * `WorkflowOutputOf` is what names the output type — the same helper a page uses
 * to type `run.output`, and the reason this signature does not have to reach
 * past the declaration into the body's own return type.
 */
function describeRun(run: WorkflowRunSnapshot<WorkflowOutputOf<typeof research>>): string {
  // `isTerminal` narrows to the three finished statuses, which is what makes
  // `run.output` and `run.error` reachable without a cast.
  if (!isTerminal(run)) return "Still working on it.";
  switch (run.status) {
    case "completed":
      return `Done: ${run.output.summary} (${run.output.sources} sources)`;
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
