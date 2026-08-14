import { agent } from "@alexkroman1/aai";
import { gameSlot } from "./shared.ts";
import systemPrompt from "./system-prompt.md?raw";

export default agent({
  name: "Solo RPG",
  // The campaign exists before the first tool call, so a resumed connection
  // has something to project rather than an empty state object.
  state: gameSlot.state,
  systemPrompt,
  greeting:
    "Welcome. Tell me your name, or describe the kind of story you want, and we will begin. You can say something like, dark fantasy warrior named Kael, or just give me a name and I will build a world around you.",
  sttPrompt:
    "Solo RPG terms: strong hit, weak hit, miss, momentum, chaos factor, clock, disposition, bond, edge, heart, iron, shadow, wits, face danger, compel, gather information, secure advantage, clash, strike, endure harm, endure stress, make connection, test bond, resupply, world shaping",
  maxSteps: 8,

  // One declaration replaces a `ctx.send("game_state", state)` in every
  // state-mutating tool — six of them, and adding a seventh meant
  // remembering to push or watching the UI quietly fall out of sync.
  syncState: gameSlot.read,
});
