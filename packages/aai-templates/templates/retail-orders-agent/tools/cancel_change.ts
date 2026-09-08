import { z } from "zod";
import { retailTool } from "../store.ts";

/**
 * Drop the staged change and go back to helping.
 *
 * Clears `pending` UNCONDITIONALLY and always sends `SETTLED`, so this is the
 * way out of `awaitingConfirmation` from any state the store could be in — a
 * caller who says no, changes their mind about one item, or wants to talk about
 * something else entirely must never leave the call wedged on a change nobody
 * is going to make.
 */
export default retailTool({
  name: "cancel_change",
  when: "serving.awaitingConfirmation",
  send: { type: "SETTLED" },
  description:
    "Drop the change that is waiting, without applying it. Use this when the caller says no, " +
    "hesitates, wants any part of it different, or moves on to something else. Nothing was " +
    "changed, so there is nothing to undo — stage the corrected change afterwards if they want one.",
  inputSchema: z.object({}),
  execute: (_args, state) => {
    const dropped = state.pending;
    state.pending = null;
    return {
      dropped: dropped?.kind ?? null,
      message: dropped
        ? `Dropped — nothing was changed. The caller did not agree to: ${dropped.plan.readBack}.`
        : "Nothing was staged, so nothing was dropped.",
    };
  },
  summary: (_args, result) => `dropped ${result.dropped ?? "nothing"}`,
});
