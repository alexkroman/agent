import { z } from "zod";
import { applyAction } from "../pending.ts";
import { retailTool } from "../store.ts";

/**
 * The only tool in this template that writes to the store.
 *
 * Gated on `serving.awaitingConfirmation`, which is reachable only by staging a
 * change — so "confirm what nobody staged" is refused by the SDK before this
 * body runs, and the refusal quotes the state's own instruction. See
 * `pending.ts`.
 */
export default retailTool({
  name: "confirm_change",
  when: "serving.awaitingConfirmation",
  send: { type: "SETTLED" },
  description:
    "Apply the change that is waiting, after you have read it back to the caller and heard an " +
    "explicit yes. Never call this on an implied yes, on silence, or before you have said what " +
    "the change is. If they say no, or want any part of it different, call cancel_change instead.",
  inputSchema: z.object({}),
  execute: (_args, state) => {
    const action = state.pending;
    // Unreachable while the gate holds: `awaitingConfirmation` is entered only
    // by a staging tool, which writes `pending` in the same synchronous window
    // it sends `STAGED` in. Kept and reported rather than thrown for the reason
    // `authenticatedUser` keeps its own — this runs mid-call, and a sentence
    // the model can act on beats an exception. `cancel_change` is the way out
    // if it ever did fire, which is why that tool clears unconditionally.
    if (!action) {
      return {
        error:
          "Nothing is staged, so there is nothing to confirm. Stage the change again with the " +
          "tool for it, read it back, and confirm once the caller says yes.",
      };
    }
    const result = applyAction(state, action);
    state.pending = null;
    return { confirmed: action.kind, ...result };
  },
  summary: (_args, result) => `confirmed ${result.confirmed}`,
});
