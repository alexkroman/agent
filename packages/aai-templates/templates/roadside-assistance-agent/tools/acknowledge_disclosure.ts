import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { roadsideCall } from "../call.ts";
import { roadsideSlot } from "../shared.ts";

/**
 * What the caller said about the fee, and the only way out of
 * `onCall.disclosure`. `sendFrom` rather than `send`, because the outcome picks
 * the transition: a yes moves the call to dispatch, and a no leaves it exactly
 * where it is — `undefined` is "that worked and it moved nothing", which is not
 * a failure, since declining a fee is not an error.
 */
export default roadsideSlot.updateTool(
  {
    description:
      "Record the caller's answer to the fee disclosure, after you have read it to them in full. " +
      "Set accepted to true only if they said yes to the charge. If they said no, or want to " +
      "think, set it to false — the call stays where it is and you can read it again.",
    dialog: roadsideCall,
    when: "onCall.disclosure",
    inputSchema: z.object({
      accepted: z.boolean().describe("Whether the caller agreed to the fee"),
      inTheirWords: z
        .string()
        .max(200)
        .optional()
        .describe("What they actually said, for the call log"),
    }),
    // The disclosure has to have been HANDED OVER first. A live desk was
    // measured taking the caller's yes and dispatching on a fee nobody had
    // read; a yes to something nobody said is not a yes.
    require: (state) =>
      state.disclosureReadAt === null
        ? toolFailure(
            "The caller has not heard the fee disclosure yet. Call service_disclosure, read back " +
              "exactly what it returns, and only then record their answer.",
          )
        : undefined,
    execute(args, state, ctx) {
      state.disclosureAcceptedAt = args.accepted ? ctx.now() : null;
      state.log.push(args.accepted ? "Fee disclosure accepted" : "Fee disclosure declined");
      return {
        accepted: args.accepted,
        saidAt: state.disclosureAcceptedAt,
        heard: args.inTheirWords ?? null,
      };
    },
  },
  { sendFrom: (result) => (result.accepted ? { type: "DISCLOSED" } : undefined) },
);
