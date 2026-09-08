import { z } from "zod";
import {
  describeRanked,
  hiringFlow,
  hiringSlot,
  MAX_FEEDBACK_ROUNDS,
  stageLabel,
  topCandidates,
} from "../shared.ts";

/**
 * Where the screening stands — and the one tool here that spends no model.
 *
 * The STAGE comes off the flow's own position, never off the data: "is there a
 * job" and "are there drafts" are what the three removed guards would have
 * asked, and deriving the stage from them a second time is exactly the drift
 * the dialog exists to end.
 *
 * **Legal in every state, which is why it is not a `hiringFlow.tool` — and a
 * `hiringSlot.tool` rather than a `tool()` opening with `hiringSlot.get(ctx)`.**
 * The declaration is what makes "does this write?" visible: the body is handed
 * the state already frozen, so a line that tried to mutate it stops compiling
 * instead of throwing on the first live call. `plan-and-execute`'s `plan_status`
 * is the same tool in the same position.
 */
export default hiringSlot.tool({
  description:
    "Where things stand: the role, how many were screened, the current top three, the " +
    "feedback rounds used, and whether emails are drafted. Use it when the caller asks " +
    "where you are, or to pick the thread back up.",
  inputSchema: z.object({}),
  execute(_args, state, ctx) {
    const at = hiringFlow.position(ctx);
    const top = topCandidates(state);
    return {
      stage: stageLabel(at),
      job: state.job?.title ?? null,
      screened: Object.keys(state.scores).length,
      unscored: state.unscored.length,
      top: top.map(describeRanked),
      feedbackRounds: `${state.rounds} of ${MAX_FEEDBACK_ROUNDS}`,
      feedback: state.feedback,
      drafts: state.drafts.length,
      message:
        at.state === "idle"
          ? "Nothing screened yet — confirm the role and offer to screen the applicants."
          : "Say where things stand in one breath, then what the caller can do next.",
      ...at,
    };
  },
});
