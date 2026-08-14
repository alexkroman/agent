import { tool } from "@alexkroman1/aai";
import { research } from "../shared.ts";

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
    // `0` is an honest answer, not a failure: the run had already moved past
    // its wait, or finished.
    const woken = await ctx.workflows.wakeUp(latest.runId);
    return woken > 0
      ? { filed: true, note: "Filing it now." }
      : { filed: false, note: "That one was not waiting — it has already moved on." };
  },
});
