import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { roadsideCall } from "../call.ts";
import { roadsideSlot } from "../shared.ts";

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
      // The disclosure has to have been HANDED OVER first, and this is the only
      // thing that checks it. "after you have read it to them in full" was a
      // sentence in the description above and nothing else: a live desk was
      // measured calling `lookup_coverage`, this tool and `dispatch_truck`
      // while never calling `service_disclosure`, so a truck went out on a fee
      // the caller had never been read. A refusal rather than a silent
      // recording, because a yes to something nobody said is not a yes.
      if (state.disclosureReadAt === null) {
        return toolFailure(
          "The caller has not heard the fee disclosure yet. Call service_disclosure, read back " +
            "exactly what it returns, and only then record their answer.",
        );
      }
      state.disclosureAcceptedAt = args.accepted ? Date.now() : null;
      state.log.push(args.accepted ? "Fee disclosure accepted" : "Fee disclosure declined");
      return {
        accepted: args.accepted,
        saidAt: state.disclosureAcceptedAt,
        heard: args.inTheirWords ?? null,
      };
    }),
  sendFrom: (result) => (result.accepted ? { type: "DISCLOSED" } : undefined),
});
