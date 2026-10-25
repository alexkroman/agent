import { withInstruction } from "@alexkroman1/aai";
import { gameFlow } from "../game.ts";
import { currentWord, gameSlot, requireWord, secondsLeft } from "../shared.ts";

/** Their host's rule 7: "repeat" or "what was that?" — the current word, nothing else. */
export default gameSlot.tool({
  description:
    "The describer asked to hear their word again. Returns the current word - say ONLY 'Your word " +
    "is X', nothing more. The score does not change.",
  dialog: gameFlow,
  when: "playing",
  require: requireWord,
  execute: (_args, game, ctx) => {
    const word = currentWord(game) ?? "";
    return withInstruction(
      { word, secondsLeft: secondsLeft(game, ctx.now()) },
      `Your word is ${word}.`,
    );
  },
});
