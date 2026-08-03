import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import { getGameState, saveSlotKey, saveSlotParam, saveState } from "../shared.ts";

// Requires storage — `aai storage enable` (or DATABASE_URL in .env under
// `aai dev`); the rest of the game works without it.
export const saveGame = tool({
  description: "Save current game to persistent storage.",
  inputSchema: z.object({ slot: saveSlotParam }),
  async execute(args, ctx) {
    const state = getGameState(ctx);
    await saveState(ctx, saveSlotKey(args.slot), state);
    return {
      saved: true,
      slot: args.slot ?? "autosave",
      name: state.playerName,
      scene: state.sceneCount,
    };
  },
});
