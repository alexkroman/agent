import { tool, toolFailure } from "@alexkroman1/aai";
import { mapSettled, partitionSettled } from "@alexkroman1/aai/step";
import { z } from "zod";
import { briefingSlot, MAX_ANGLES, researchAngle } from "../shared.ts";

/**
 * Fan a topic out across angles, one researcher subagent each, in PARALLEL.
 *
 * **The settled fan-out is the template's whole point.** Each angle is an
 * independent run with its own context window, so four of them cost the caller
 * the SLOWEST one rather than the sum — and nothing they read reaches this
 * conversation, only what each one concluded. Running the same four angles as
 * four `ctx.generate` calls in one loop would be slower and would put every
 * intermediate page in the desk's own prompt.
 *
 * **Settled, not raced.** One angle that fails (a provider hiccup, a subagent
 * that ran out of budget with nothing to say) must not sink a briefing whose
 * other three came back — a caller on the phone would rather hear three answers
 * and one apology than an error. `mapSettled` keeps each angle beside its
 * outcome, so the failures are reported BY ANGLE and the desk can say which one
 * is missing and offer to retry it. `Infinity` is the width `allSettled` had:
 * `MAX_ANGLES` already bounds the fan-out at the schema.
 *
 * **The await comes first, then the mutation.** `slot.update`'s window is
 * synchronous by contract, so the fan-out finishes before the board is touched
 * and the whole write lands at once.
 */
export default tool({
  description:
    "Research a topic across several angles at once and report what each one " +
    "found. Use this when the caller asks about something you would need to " +
    "look up. Pick the angles yourself from what they said — two or three is " +
    "usually right. Tell them you are looking it up before you call this.",
  inputSchema: z.object({
    topic: z.string().max(200).describe("The subject, in the caller's own terms"),
    angles: z
      .array(z.string().max(200))
      .min(1)
      .max(MAX_ANGLES)
      .describe(
        "The separate questions to research, one per researcher. Each must " +
          "stand on its own: a researcher has not heard the conversation.",
      ),
  }),
  async execute(args, ctx) {
    const angles = args.angles.map((angle) => angle.trim()).filter((angle) => angle.length > 0);
    if (angles.length === 0) {
      return toolFailure("No angles to research — say what the caller wants looked up.");
    }

    const { ok, failed } = partitionSettled(
      await mapSettled(angles, Number.POSITIVE_INFINITY, (angle) =>
        researchAngle(ctx.delegate, args.topic, angle),
      ),
    );
    if (ok.length === 0) {
      return toolFailure(
        `Every angle failed. The first said: ${failed[0]?.error ?? "no reason given"}`,
      );
    }
    const summaries = ok.map((one) => one.value);
    const failures = failed.map((one) => ({ angle: one.item, error: one.error }));

    return briefingSlot.update(ctx, (board) => {
      board.topic = args.topic;
      board.findings.push(...summaries);
      return {
        topic: args.topic,
        findings: summaries,
        failed: failures,
        message:
          "Give the caller the through-line first, in one or two sentences, then " +
          "the angles. Do not read the summaries out verbatim." +
          (failures.length > 0
            ? " Mention which angle you could not get to and offer to try it again."
            : ""),
      };
    });
  },
});
