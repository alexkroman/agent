import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import type { GameState } from "../shared.ts";
import { gameSlot, loadState, saveSlotKey, saveSlotParam, storyFlow } from "../shared.ts";

// Requires storage — `aai storage enable` (or DATABASE_URL in .env under
// `aai dev`); the rest of the game works without it.
export default tool({
  description: "Load a previously saved game.",
  inputSchema: z.object({ slot: saveSlotParam }),
  async execute(args, ctx) {
    const saved = await loadState<GameState>(ctx, saveSlotKey(args.slot));
    if (!saved) return { error: "No save found." };
    // The restore is the whole move: `storyFlow` is derived from the campaign, so
    // writing it puts the position wherever the saved data says it already was —
    // a standing roll included. This used to rebuild the position by hand and
    // dropped `lastRoll` doing it, which refused a legal burn after every reload.
    gameSlot.set(ctx, saved);
    const at = storyFlow.position(ctx);

    return {
      loaded: true,
      at: at.state,
      next: at.instruction,
      playerName: saved.playerName,
      characterConcept: saved.characterConcept,
      settingGenre: saved.settingGenre,
      sceneCount: saved.sceneCount,
      currentLocation: saved.currentLocation,
      initialized: saved.initialized,
    };
  },
});
