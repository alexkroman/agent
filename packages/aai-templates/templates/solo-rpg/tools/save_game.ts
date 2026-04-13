import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import type { KV } from "../shared.ts";
import { getGameState } from "../shared.ts";

export const saveGame = tool({
  description: "Save current game to persistent storage.",
  parameters: z.object({
    slot: z.string().describe("Save slot name, defaults to autosave").optional(),
  }),
  async execute(args, ctx: { kv: KV }) {
    const state = await getGameState(ctx.kv);
    await ctx.kv.set(`save:${args.slot ?? "autosave"}`, state);
    return {
      saved: true,
      slot: args.slot ?? "autosave",
      name: state.playerName,
      scene: state.sceneCount,
    };
  },
});
