import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { roadsideCall } from "../call.ts";
import { findPolicy, quoteFee, rateFor, roadsideSlot } from "../shared.ts";

/**
 * What this caller is covered for — the one thing on this call that must never
 * be guessed.
 *
 * Three outcomes, and the difference between them is the reason this is a tool
 * rather than a prompt rule:
 *
 * - a policy that matches → the plan is latched and the call moves on;
 * - **no policy number at all** (`policyNumber` omitted) → the caller has told
 *   us they have no plan or cannot find it, which is an ANSWER: coverage stays
 *   `null`, the call still moves on, and the non-member rate is what the
 *   disclosure will quote;
 * - a number that matches NOTHING → a `ToolFailure`. The call does not move,
 *   because "I misheard four digits" and "you have no plan" are the same price
 *   and very much not the same sentence.
 *
 * The third case is where the `send` contract earns its keep: a gated tool
 * sends nothing when its body answers a failure, so a mistyped policy number
 * cannot leave the caller quoted at a rate nobody looked up.
 */
export default roadsideCall.tool({
  description:
    "Look up the caller's roadside plan by the policy number on their card. Omit policyNumber " +
    "only if they have told you they have no plan or cannot find the number — that is an " +
    "answer, and it is priced as a non-member. Never tell a caller they are covered without " +
    "calling this.",
  when: "onCall.verifying",
  send: { type: "VERIFIED" },
  inputSchema: z.object({
    policyNumber: z
      .string()
      .max(40)
      .optional()
      .describe("The policy number as they read it out, e.g. 'RS-4417'. Omit if they have none."),
  }),
  execute: (args, ctx) =>
    roadsideSlot.update(ctx, (state) => {
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
      // The zero-mile quote, which is what the caller owes if the driver fixes
      // it at the roadside. `quoteFee` is the same function `dispatch_truck`
      // prices the tow with — there is one of it precisely so the number the
      // caller hears now and the number on the invoice cannot drift.
      return {
        plan: rate.name,
        holder: state.coverage?.holder ?? null,
        status: state.coverage?.status ?? "unverified",
        callOut: rate.callOut,
        freeTowMiles: rate.freeTowMiles,
        perMile: rate.perMile,
        ifNoTowNeeded: quoteFee(rate, 0).total,
      };
    }),
});
