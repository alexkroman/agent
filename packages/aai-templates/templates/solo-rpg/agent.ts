import { agent } from "@alexkroman1/aai";
import { assemblyAI as assemblyAILlm } from "@alexkroman1/aai/llm";
import { assemblyAI } from "@alexkroman1/aai/stt";
import { assemblyAI as assemblyAITts } from "@alexkroman1/aai/tts";
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
  stt: assemblyAI({ model: "universal-3-5-pro" }),
  llm: assemblyAILlm({ model: "qwen3-next-80b-a3b" }),
  tts: assemblyAITts({ voice: "vera" }),
  systemPrompt,
  greeting:
    "Welcome. Tell me your name, or describe the kind of story you want, and we will begin. You can say something like, dark fantasy warrior named Kael, or just give me a name and I will build a world around you.",
  sttPrompt:
    "Solo RPG terms: strong hit, weak hit, miss, momentum, chaos factor, clock, disposition, bond, edge, heart, iron, shadow, wits, face danger, compel, gather information, secure advantage, clash, strike, endure harm, endure stress, make connection, test bond, resupply, world shaping",
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
