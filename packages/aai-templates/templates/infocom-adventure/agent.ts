import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Cavern Adventure",
  // The world exists before the first command, so a resumed connection has
  // something to project rather than an empty state object.
  // A narrator wants a narrative voice; everything else stays on the
  // default all-AssemblyAI pipeline.
  voice: "paul",
  // The opening scene here must agree with DEFAULT_GAME_STATE.currentRoom
  // (shared.ts) and the world map in system-prompt.md.
  greeting:
    "Welcome, adventurer. You are standing at the mouth of a weathered cave at the edge of a pine forest. A cold wind carries the smell of damp stone up from the darkness below. A rusted lantern hangs from an iron hook beside the entrance. What would you like to do?",
});
