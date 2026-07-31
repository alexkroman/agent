import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import { getGameState, saveSlotKey, saveState } from "../shared.ts";

// Requires storage — `aai storage enable` (or DATABASE_URL in .env under
// `aai dev`); the rest of the game works without it.
export const saveGame = tool({
  description: "Save current game to persistent storage.",
  parameters: z.object({
    slot: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,32}$/, "letters, digits, dashes, underscores; max 32 chars")
      .describe("Save slot name, defaults to autosave")
      .optional(),
  }),
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
