import { z } from "zod";
import { LOCATING, roadsideCall } from "../call.ts";
import { roadsideSlot, SITUATIONS } from "../shared.ts";

/**
 * The end of the silence ladder: the caller has told us where they are, what
 * they are driving, and what went wrong.
 *
 * Legal on BOTH rungs ({@link LOCATING}), because the whole point of the nudge
 * in `onCall.quiet` is to get this call — refusing it one beat after asking for
 * it would be the gate working against the conversation it is gating.
 *
 * `LOCATED` is what moves the call to `onCall.verifying`, and nothing is sent
 * when this body answers a `ToolFailure`: a location we could not accept must
 * not leave the desk believing it has one.
 */
export default roadsideCall.tool({
  description:
    "Record where the caller is, what they are driving, and what has gone wrong. Call this " +
    "once you have all four: where they are, whether they can safely wait there, the vehicle, " +
    "and which of the listed situations it is. Do not guess the situation — ask.",
  when: LOCATING,
  send: { type: "LOCATED" },
  inputSchema: z.object({
    where: z
      .string()
      .max(300)
      .describe("Where the caller says they are, in their own words — a road, an exit, an address"),
    landmark: z
      .string()
      .max(120)
      .optional()
      .describe("Anything a driver can steer by: a mile marker, an exit number, a storefront"),
    safeToWait: z
      .boolean()
      .describe("Whether they are somewhere they can wait. A live traffic lane is not."),
    situation: z.enum(SITUATIONS).describe("What has gone wrong"),
    make: z.string().max(40).describe("Vehicle make, e.g. 'Toyota'"),
    model: z.string().max(40).describe("Vehicle model, e.g. 'Corolla'"),
    year: z.number().int().min(1950).max(2100).optional().describe("Model year, if they know it"),
    color: z
      .string()
      .max(30)
      .optional()
      .describe("Vehicle colour — this is what the driver looks for"),
  }),
  execute: (args, ctx) =>
    roadsideSlot.update(ctx, (state) => {
      if (args.where.trim() === "") {
        return {
          error:
            "That location is empty. Ask again — a road name and the nearest exit or cross " +
            "street is enough for a driver to find them.",
        };
      }
      state.where = {
        described: args.where.trim(),
        landmark: args.landmark ?? null,
        safeToWait: args.safeToWait,
      };
      state.vehicle = {
        year: args.year ?? null,
        make: args.make,
        model: args.model,
        color: args.color ?? null,
      };
      state.situation = args.situation;
      state.log.push(`Located: ${state.where.described} (${args.situation})`);
      return {
        where: state.where.described,
        landmark: state.where.landmark,
        safeToWait: state.where.safeToWait,
        situation: args.situation,
        // Said back so the model has something concrete to confirm out loud
        // before it starts asking about the policy number.
        vehicle: `${args.color ?? ""} ${args.make} ${args.model}`.trim(),
      };
    }),
});
