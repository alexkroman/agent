import { agent } from "@alexkroman1/aai";
import systemPrompt from "./system-prompt.md";
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
  systemPrompt,
  greeting:
    "Welcome. Tell me your name, or describe the kind of story you want, and we will begin. You can say something like, dark fantasy warrior named Kael, or just give me a name and I will build a world around you.",
  sttPrompt:
    "Solo RPG terms: strong hit, weak hit, miss, momentum, chaos factor, clock, disposition, bond, edge, heart, iron, shadow, wits, face danger, compel, gather information, secure advantage, clash, strike, endure harm, endure stress, make connection, test bond, resupply, world shaping",
  builtinTools: ["run_code"],
  maxSteps: 8,

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
