import { withInstruction } from "@alexkroman1/aai";
import { gameFlow, type RoundEnd } from "../game.ts";
import { advanceWord, currentWord, gameSlot, requireWord, score } from "../shared.ts";

/**
 * Their host's rule 6: "skip" or "pass" gets a new word, and the score does not
 * change. Unlimited, as on the phone (their web client capped it at three).
 */
export default gameSlot.updateTool({
  description:
    "The describer said skip, pass, or next: move to the next word without a point. The result " +
    "carries the new word to give them.",
  dialog: gameFlow,
  when: "playing",
  sendFrom: "next",
  require: requireWord,
  execute: (_args, game) => {
    const skipped = advanceWord(game, "skipped") ?? "";
    game.lastRemark = null;
    const nextWord = currentWord(game);
    const next: RoundEnd = nextWord === null ? "WORDS_DONE" : undefined;
    return withInstruction(
      { skipped, nextWord, score: score(game), next },
      nextWord === null ? "That was the last word." : `The new word is ${nextWord}.`,
    );
  },
});
