import { z } from "zod";
import { gameSlot, saveSlotKey, saveSlotParam, saveState, storyFlow } from "../shared.ts";

// Requires a DATABASE_URL you supply — a secret when deployed (or .env under
// `aai dev`); the rest of the game works without it.
//
/**
 * Gated on `playing` or `gameOver` — i.e. anything but `awaitingSetup`.
 *
 * Saving before a character exists writes an empty campaign under a slot name,
 * and `load_game` would then cheerfully restore it over a real game. That is a
 * position, so it is a `when`.
 *
 * The body AWAITS, which a flow tool allows: only `slot.updateTool` must be
 * synchronous, because its draft is stored when it returns. What a save needs is
 * the frozen value, and `gameSlot.get` is what hands it over.
 */
export default storyFlow.tool({
  description: "Save current game to persistent storage.",
  inputSchema: z.object({ slot: saveSlotParam }),
  when: ["playing", "gameOver"],
  async execute(args, ctx) {
    const game = gameSlot.get(ctx);
    await saveState(ctx, saveSlotKey(args.slot), game);
    return {
      saved: true,
      slot: args.slot ?? "autosave",
      name: game.playerName,
      scene: game.sceneCount,
    };
  },
});
