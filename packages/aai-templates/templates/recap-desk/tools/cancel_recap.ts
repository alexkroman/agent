import { tool } from "@alexkroman1/aai";
import { recap } from "../shared.ts";

export default tool({
  description: "Stop the recap that is running. Use when the caller says to forget it.",
  execute: async (_args, ctx) => {
    const [latest] = await ctx.workflows.find(recap, ctx.sessionId, { limit: 1 });
    if (!latest) return { cancelled: false, note: "Nothing started yet." };
    const cancelled = await ctx.workflows.cancel(latest.runId);
    // `false` is an ANSWER, not a failure: the run was already terminal, so
    // there was nothing to stop. Worth distinguishing out loud — "already
    // done" and "stopped" are different things to a caller.
    return cancelled
      ? {
          cancelled: true,
          // Said plainly because it is true: a cancelled run does not run
          // its compensations (see `agent.ts`'s module doc), so the
          // transcript it had already created stays on the account.
          note: "Stopped it. The partial transcript is left behind — cancelling does not roll back.",
        }
      : { cancelled: false, note: "That one had already finished." };
  },
});
