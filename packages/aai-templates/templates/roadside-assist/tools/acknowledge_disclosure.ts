import { z } from "zod";
import { roadsideCall } from "../call.ts";
import { note, roadsideSlot } from "../shared.ts";

/**
 * What the caller said about the fee, and the only way out of
 * `onCall.disclosure`.
 *
 * `sendFrom` rather than `send`, because the outcome picks the transition: a
 * caller who agrees moves the call to dispatch, and one who does not stays
 * exactly where they are. Returning `undefined` from `sendFrom` is how a tool
 * says "that worked, and it did not move the conversation" — which is a
 * different thing from a `ToolFailure`, since declining a fee is not an error.
 *
 * **`sendFrom` is declared BELOW `execute`, and that is a rule rather than a
 * habit.** `execute` here is an inline arrow whose parameters are contextually
 * typed, so its return type is inferred in a later pass than this signature is
 * checked: written above, `result` lands as `unknown` and `result.accepted` is
 * a `TS18046`. The failure arm is already subtracted for us — a body that
 * answered a `ToolFailure` never reaches `sendFrom` at all.
 */
export default roadsideCall.tool({
  description:
    "Record the caller's answer to the fee disclosure, after you have read it to them in full. " +
    "Set accepted to true only if they said yes to the charge. If they said no, or want to " +
    "think, set it to false — the call stays where it is and you can read it again.",
  when: "onCall.disclosure",
  inputSchema: z.object({
    accepted: z.boolean().describe("Whether the caller agreed to the fee"),
    inTheirWords: z
      .string()
      .max(200)
      .optional()
      .describe("What they actually said, for the call log"),
  }),
  execute: (args, ctx) =>
    roadsideSlot.update(ctx, (state) => {
      state.disclosureAcceptedAt = args.accepted ? Date.now() : null;
      note(state, args.accepted ? "Fee disclosure accepted" : "Fee disclosure declined");
      return {
        accepted: args.accepted,
        saidAt: state.disclosureAcceptedAt,
        heard: args.inTheirWords ?? null,
      };
    }),
  sendFrom: (result) => (result.accepted ? { type: "DISCLOSED" } : undefined),
});
