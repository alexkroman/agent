import { toolFailure, withInstruction } from "@alexkroman1/aai";
import { z } from "zod";
import { roadsideCall } from "../call.ts";
import { findPolicy, quoteFee, rateFor, roadsideSlot } from "../shared.ts";

/**
 * What this caller is covered for — the one thing on this call that must never
 * be guessed. Three outcomes:
 *
 * - a policy that matches → the plan is latched and the call moves on;
 * - **no policy number at all** → the caller has told us they have no plan or
 *   cannot find it, which is an ANSWER: coverage stays `null`, the call still
 *   moves on, and the non-member rate is what the disclosure will quote;
 * - a number that matches NOTHING → a `ToolFailure`, and nothing is sent: "I
 *   misheard four digits" and "you have no plan" are the same price and very
 *   much not the same sentence.
 */
export default roadsideSlot.updateTool({
  description:
    "Look up the caller's roadside plan by the policy number on their card. Omit policyNumber " +
    "only if they have told you they have no plan or cannot find the number — that is an " +
    "answer, and it is priced as a non-member. Never tell a caller they are covered without " +
    "calling this.",
  dialog: roadsideCall,
  when: "onCall.verifying",
  send: { type: "VERIFIED" },
  inputSchema: z.object({
    policyNumber: z
      .string()
      .max(40)
      .optional()
      .describe("The policy number as they read it out, e.g. 'RS-4417'. Omit if they have none."),
  }),
  execute(args, state) {
    if (args.policyNumber !== undefined) {
      const found = findPolicy(args.policyNumber);
      if (!found) {
        return toolFailure(
          `No plan is on file under ${args.policyNumber}. Read it back to them digit by ` +
            "digit and try once more. If they cannot find the card, call this again with no " +
            "policy number and we will price it as a non-member.",
        );
      }
      state.coverage = { ...found };
    } else {
      state.coverage = null;
    }
    const rate = rateFor(state.coverage);
    state.log.push(`Coverage: ${rate.name}`);
    // The figures price the job; they are NOT a script. A live desk handed
    // every number answered the policy number with a sentence about the fee
    // and never called `service_disclosure`, so the instruction names the next
    // call where the model is actually looking. `ifNoTowNeeded` is the
    // zero-mile quote, through the same `quoteFee` the invoice uses.
    return withInstruction(
      {
        plan: rate.name,
        holder: state.coverage?.holder ?? null,
        status: state.coverage?.status ?? "unverified",
        callOut: rate.callOut,
        freeTowMiles: rate.freeTowMiles,
        perMile: rate.perMile,
        ifNoTowNeeded: quoteFee(rate, 0).total,
      },
      "Call service_disclosure now, in this same turn, and read back exactly what it " +
        "returns. Do not say any of these numbers in your own words — the disclosure is " +
        "the only wording the caller may hear the fee in.",
    );
  },
});
