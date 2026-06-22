import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import type { KV } from "../shared.ts";
import { getGameState, RESULT_LABELS, saveGameState } from "../shared.ts";

export const burnMomentum = tool({
  description:
    "Burn momentum to upgrade a roll result. Only valid when current momentum beats both challenge dice for the roll being upgraded. Resets momentum to +2.",
  parameters: z.object({
    c1: z.number().describe("First challenge die from the roll"),
    c2: z.number().describe("Second challenge die from the roll"),
  }),
  async execute(args, ctx: { kv: KV; send: (event: string, data: unknown) => void }) {
    const state = await getGameState(ctx.kv);
    const previousMomentum = state.momentum;
    if (previousMomentum <= 0) return { error: "Momentum is 0 or negative. Cannot burn." };

    let newResult: string;
    if (previousMomentum > args.c1 && previousMomentum > args.c2) newResult = "STRONG_HIT";
    else if (previousMomentum > args.c1 || previousMomentum > args.c2) newResult = "WEAK_HIT";
    else return { error: "Momentum not high enough to improve the result." };

    state.momentum = 2; // Reset to starting value
    await saveGameState(ctx.kv, state);
    ctx.send("game_state", state);

    return {
      burned: true,
      previousMomentum,
      newMomentum: 2,
      newResult: RESULT_LABELS[newResult],
      newResultCode: newResult,
      challengeDice: [args.c1, args.c2],
    };
  },
});
