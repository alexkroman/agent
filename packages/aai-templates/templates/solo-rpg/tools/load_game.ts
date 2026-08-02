import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import type { GameState } from "../shared.ts";
import { loadState, saveGameState, saveSlotKey } from "../shared.ts";

// Requires storage — `aai storage enable` (or DATABASE_URL in .env under
// `aai dev`); the rest of the game works without it.
export const loadGame = tool({
  description: "Load a previously saved game.",
  parameters: z.object({
    slot: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,32}$/, "letters, digits, dashes, underscores; max 32 chars")
      .describe("Save slot name, defaults to autosave")
      .optional(),
  }),
  async execute(args, ctx) {
    const saved = await loadState<GameState>(ctx, saveSlotKey(args.slot));
    if (!saved) return { error: "No save found." };
    saveGameState(ctx, saved);
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
