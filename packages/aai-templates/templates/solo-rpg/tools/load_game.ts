import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import type { GameState, KV } from "../shared.ts";
import { saveGameState } from "../shared.ts";

export const loadGame = tool({
  description: "Load a previously saved game.",
  parameters: z.object({
    slot: z.string().describe("Save slot name, defaults to autosave").optional(),
  }),
  async execute(args, ctx: { kv: KV }) {
    const saved = await ctx.kv.get<GameState>(`save:${args.slot ?? "autosave"}`);
    if (!saved) return { error: "No save found." };
    await saveGameState(ctx.kv, saved);
    return {
      loaded: true,
      playerName: saved.playerName,
      characterConcept: saved.characterConcept,
      settingGenre: saved.settingGenre,
      sceneCount: saved.sceneCount,
      currentLocation: saved.currentLocation,
      initialized: saved.initialized,
    };
  },
});
