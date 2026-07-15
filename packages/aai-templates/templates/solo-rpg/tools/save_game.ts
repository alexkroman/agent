import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import { getGameState, saveSlotKey } from "../shared.ts";

export const saveGame = tool({
  description: "Save current game to persistent storage.",
  parameters: z.object({
    slot: z.string().describe("Save slot name, defaults to autosave").optional(),
  }),
  async execute(args, ctx) {
    const state = await getGameState(ctx.kv);
    await ctx.kv.set(saveSlotKey(args.slot), state);
    return {
      saved: true,
      slot: args.slot ?? "autosave",
      name: state.playerName,
      scene: state.sceneCount,
    };
  },
});
