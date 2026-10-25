import { agent } from "@alexkroman1/aai";
import { gameSlot, liveSheet, storyFlow } from "./shared.ts";

export default agent({
  name: "Solo RPG",
  // What the borrowed systems DO rather than their names — the attribution is
  // `shared.ts`'s, not a picker row's.
  listing: "Narrates a solo tabletop campaign and keeps its dice, tracks and clocks",
  greeting:
    "Welcome. Tell me your name, or describe the kind of story you want, and we will begin. You can say something like, dark fantasy warrior named Kael, or just give me a name and I will build a world around you.",
  sttPrompt:
    "Solo RPG terms: strong hit, weak hit, miss, momentum, chaos factor, clock, disposition, bond, edge, heart, iron, shadow, wits, face danger, compel, gather information, secure advantage, clash, strike, endure harm, endure stress, make connection, test bond, resupply, world shaping",
  maxSteps: 8,
  // The campaign sheet as it stands, under the rules on every request — so the
  // tracks, the clocks and the cast are never guessed from prior turns.
  promptContext: (ctx) => liveSheet(gameSlot.get(ctx)),
  // The flow gates the tools whether or not it is declared here. Declaring it
  // puts the active state's `instruction` in front of the model on every turn,
  // not only on the turns a tool result happens to carry it back.
  dialogs: [storyFlow],
});
