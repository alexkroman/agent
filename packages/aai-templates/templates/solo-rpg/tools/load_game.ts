import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import type { GameState } from "../shared.ts";
import { gameSlot, loadState, resumeStory, saveSlotKey, saveSlotParam } from "../shared.ts";

// Requires storage — `aai storage enable` (or DATABASE_URL in .env under
// `aai dev`); the rest of the game works without it.
export default tool({
  description: "Load a previously saved game.",
  inputSchema: z.object({ slot: saveSlotParam }),
  async execute(args, ctx) {
    const saved = await loadState<GameState>(ctx, saveSlotKey(args.slot));
    if (!saved) return { error: "No save found." };
    gameSlot.set(ctx, saved);

    // The flow has to be restored alongside the campaign, or a loaded game would
    // still be sitting in `awaitingSetup` with every roll tool refusing. The
    // mapping from saved data to position is `resumeStory`'s, exhaustively and in
    // one place — see its doc for the standing roll this used to drop.
    const at = resumeStory(ctx, saved);

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
