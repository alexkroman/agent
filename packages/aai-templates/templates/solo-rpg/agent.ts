import { agent } from "@alexkroman1/aai";
import { gameSlot } from "./shared.ts";
import systemPrompt from "./system-prompt.md?raw";
import { actionRoll } from "./tools/action_roll.ts";
import { burnMomentum } from "./tools/burn_momentum.ts";
import { checkState } from "./tools/check_state.ts";
import { loadGame } from "./tools/load_game.ts";
import { oracle } from "./tools/oracle.ts";
import { saveGame } from "./tools/save_game.ts";
import { setupCharacter } from "./tools/setup_character.ts";
import { updateState } from "./tools/update_state.ts";

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
  tools: {
    action_roll: actionRoll,
    burn_momentum: burnMomentum,
    check_state: checkState,
    load_game: loadGame,
    oracle,
    save_game: saveGame,
    setup_character: setupCharacter,
    update_state: updateState,
  },
});
