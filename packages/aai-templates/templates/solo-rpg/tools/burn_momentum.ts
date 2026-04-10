import { tool } from "aai";
import { z } from "zod";
import type { KV } from "../shared.ts";
import { getGameState, saveGameState } from "../shared.ts";

export const burnMomentum = tool({
  description:
    "Burn momentum to upgrade a roll result. Only valid when current momentum beats both challenge dice for the roll being upgraded. Resets momentum to +2.",
  parameters: z.object({
    c1: z.number().describe("First challenge die from the roll"),
    c2: z.number().describe("Second challenge die from the roll"),
  }),
  async execute(args, ctx: { kv: KV }) {
    const state = await getGameState(ctx.kv);
    const mom = state.momentum;
    if (mom <= 0) return { error: "Momentum is 0 or negative. Cannot burn." };

    let newResult: string;
    if (mom > args.c1 && mom > args.c2) newResult = "STRONG_HIT";
    else if (mom > args.c1 || mom > args.c2) newResult = "WEAK_HIT";
    else return { error: "Momentum not high enough to improve the result." };

    const previousMomentum = mom;
    state.momentum = 2; // Reset to starting value
    await saveGameState(ctx.kv, state);

    const labels: Record<string, string> = {
      STRONG_HIT: "Strong Hit",
      WEAK_HIT: "Weak Hit",
    };

    return {
      burned: true,
      previousMomentum,
      newMomentum: 2,
      newResult: labels[newResult],
      newResultCode: newResult,
      challengeDice: [args.c1, args.c2],
    };
  },
});
