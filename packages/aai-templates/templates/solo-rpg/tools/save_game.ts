import { z } from "zod";
import { gameSlot, saveSlotKey, saveSlotParam, saveState } from "../shared.ts";

// Requires storage — `aai storage enable` (or DATABASE_URL in .env under
// `aai dev`); the rest of the game works without it.
//
// `gameSlot.tool` even though the body AWAITS: the reading half places no
// constraint on the body (only `updateTool` must be synchronous, because its
// draft is stored when it returns). What it does place is the frozen value, and
// a save is the purest read there is.
export default gameSlot.tool({
  description: "Save current game to persistent storage.",
  inputSchema: z.object({ slot: saveSlotParam }),
  async execute(args, game, ctx) {
    await saveState(ctx, saveSlotKey(args.slot), game);
    return {
      saved: true,
      slot: args.slot ?? "autosave",
      name: game.playerName,
      scene: game.sceneCount,
    };
  },
});
