import { agent } from "@alexkroman1/aai";
import { gameProjection, storyFlow } from "./shared.ts";

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
  // NOT the identity: `gameView` withholds the seven fields the sidebar never
  // reads and every unplayed act's goal and mood with them, which is the only
  // defence there is against a spoiler leak (see `shared.ts`). The slot's own
  // default is what a session that has run no tool projects.
  syncState: gameProjection,

  // The flow gates the tools whether or not it is declared here. What DECLARING
  // it buys is the other half the states were written for: the active state's
  // `instruction` goes in front of the model on every turn, rather than only on
  // the turns a tool result happens to carry it back. `system-prompt.md` already
  // tells the narrator to read `instruction` as ground truth — this is what
  // makes that true before the first tool call of a turn, and it is the field
  // six of the other seven flow templates declare.
  dialogs: [storyFlow],
});
