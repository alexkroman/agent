import { agent } from "@alexkroman1/aai";
import { gameProjection } from "./shared.ts";

export default agent({
  name: "Solo RPG",
  greeting:
    "Welcome. Tell me your name, or describe the kind of story you want, and we will begin. You can say something like, dark fantasy warrior named Kael, or just give me a name and I will build a world around you.",
  sttPrompt:
    "Solo RPG terms: strong hit, weak hit, miss, momentum, chaos factor, clock, disposition, bond, edge, heart, iron, shadow, wits, face danger, compel, gather information, secure advantage, clash, strike, endure harm, endure stress, make connection, test bond, resupply, world shaping",
  maxSteps: 8,

  // One declaration replaces a `ctx.send("game_state", state)` in every
  // state-mutating tool — six of them, and adding a seventh meant
  // remembering to push or watching the UI quietly fall out of sync.
  // The identity projection: this campaign IS what the client renders, and the
  // slot's own default is what a session that has run no tool projects.
  syncState: gameProjection,
});
