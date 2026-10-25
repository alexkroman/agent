import { agent } from "@alexkroman1/aai";
import { assemblyAITts } from "@alexkroman1/aai/tts";
import { gameSlot, statusBlock } from "./shared.ts";

export default agent({
  name: "Cavern Adventure",
  listing: "Runs a spoken text adventure through an underground cave system",
  syncState: gameSlot.projected,
  // A narrator wants a narrative voice; everything else stays on the default
  // all-AssemblyAI pipeline.
  tts: assemblyAITts({ voice: "aai-paul" }),
  // The board as it stands, under `system-prompt.md` on every request: the
  // narrator is told where the player is and what they carry instead of being
  // asked to call a tool before answering.
  promptContext: (ctx) => statusBlock(gameSlot.get(ctx)),
  greeting:
    "Welcome, adventurer. You are standing at the mouth of a weathered cave at the edge of a pine forest. A cold wind carries the smell of damp stone up from the darkness below. A rusted lantern hangs from an iron hook beside the entrance. What would you like to do?",
  // A move is the player saying something. Counted here rather than by a tool,
  // so a turn the narrator answers without one still counts, and the CRT's top
  // bar reads the game's own number.
  events: {
    "userTranscript.committed": (_event, ctx) =>
      gameSlot.update(ctx, (game) => {
        game.moves++;
      }),
  },
});
