import { tool } from "@alexkroman1/aai";
import type { WakeUpOptions } from "@alexkroman1/aai/workflow-api";
import { research } from "../shared.ts";
import { REVIEW_SLEEP_ID } from "../workflows/review.ts";

export default tool({
  description:
    "Skip the review wait on the research and file it immediately. Use when the caller says they need it now.",
  execute: async (_args, ctx) => {
    const [latest] = await ctx.workflows.find(research, ctx.sessionId, { limit: 1 });
    if (!latest) return { note: "Nothing started yet." };
    // The counterpart of the `sleep` in `workflows/research.ts`. Without it
    // the only handle on a sleeping run is `cancel`, so "send it now" and
    // "throw it away" would be the same button — and the wait a real desk
    // uses is hours, not the thirty seconds this template ships.
    //
    // It wakes THE REVIEW WAIT by name rather than every suspension the run is
    // holding, which is what keeps this tool's reach equal to its description:
    // a bare `wakeUp(runId)` would also end an approval waitpoint a later
    // version of the body opened, and file a report that was still waiting on
    // someone. `review.ts` owns the id both sides derive it from.
    //
    // `0` is an honest answer, not a failure: the run had already moved past
    // its wait, or finished.
    const woken = await ctx.workflows.wakeUp(latest.runId, {
      correlationIds: [REVIEW_SLEEP_ID],
    } satisfies WakeUpOptions);
    return woken > 0
      ? { filed: true, note: "Filing it now." }
      : { filed: false, note: "That one was not waiting — it has already moved on." };
  },
});
